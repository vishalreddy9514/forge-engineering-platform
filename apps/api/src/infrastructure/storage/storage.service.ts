import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env';

export interface UploadTarget {
  url: string;
  /** Headers the browser must send exactly: they are part of the signature. */
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface StoredObject {
  sizeBytes: number;
  contentType: string | undefined;
}

/** Pre-signed upload URLs expire quickly: they are requested right before the upload. */
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * Object storage behind the S3 API (AWS S3 in deployed environments, SeaweedFS locally).
 * The browser uploads and downloads directly with short-lived pre-signed URLs; file bytes
 * never pass through the API (architecture §3, NFR-2).
 */
@Injectable()
export class StorageService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  /** Signs URLs for the host browsers reach, which can differ from the API's (containers). */
  private readonly signer: S3Client;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    const endpoint = config.get('S3_ENDPOINT', { infer: true });
    const publicEndpoint = config.get('S3_PUBLIC_ENDPOINT', { infer: true });
    const accessKeyId = config.get('S3_ACCESS_KEY_ID', { infer: true });
    const secretAccessKey = config.get('S3_SECRET_ACCESS_KEY', { infer: true });
    const base: S3ClientConfig = {
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      // Without explicit keys the SDK's default chain (ECS task role) applies.
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
      // Checksums are optional for S3 and break pre-signed PUTs from browsers that
      // cannot compute them; send them only when an operation requires one.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    this.client = new S3Client({ ...base, endpoint });
    this.signer = publicEndpoint
      ? new S3Client({ ...base, endpoint: publicEndpoint })
      : this.client;
    this.bucket = config.get('S3_BUCKET', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.get('S3_ENSURE_BUCKET', { infer: true })) return;
    // Storage being down must not stop the API from starting: only attachments need it.
    await this.ensureBucket().catch((error: unknown) => {
      this.logger.error({ err: error }, 'Could not prepare the attachments bucket');
    });
  }

  onApplicationShutdown(): void {
    this.client.destroy();
    if (this.signer !== this.client) this.signer.destroy();
  }

  /**
   * A URL for one PUT of exactly this size and type. Size and type are signed, so the storage
   * service rejects any other body; the API still re-checks the stored object afterwards.
   */
  async presignUpload(
    key: string,
    file: { contentType: string; sizeBytes: number; disposition: string },
  ): Promise<UploadTarget> {
    const url = await getSignedUrl(
      this.signer,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: file.contentType,
        ContentLength: file.sizeBytes,
        ContentDisposition: file.disposition,
      }),
      {
        expiresIn: UPLOAD_URL_TTL_SECONDS,
        signableHeaders: new Set(['content-type', 'content-length', 'content-disposition']),
      },
    );
    return {
      url,
      headers: { 'Content-Type': file.contentType, 'Content-Disposition': file.disposition },
      expiresAt: new Date(Date.now() + UPLOAD_URL_TTL_SECONDS * 1000),
    };
  }

  async presignDownload(
    key: string,
    disposition: string,
  ): Promise<{ url: string; expiresAt: Date }> {
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: disposition,
      }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
    return { url, expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000) };
  }

  /** The stored object's size and type, or null when nothing was uploaded under this key. */
  async stat(key: string): Promise<StoredObject | null> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  /** Idempotent: deleting a missing object succeeds. */
  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      );
    }
  }

  /** Local dev and tests only; in AWS, Terraform owns the bucket, its policy and CORS. */
  private async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client
        .send(new CreateBucketCommand({ Bucket: this.bucket }))
        .catch((error: unknown) => {
          // Another process (API and worker start together) may have created it first.
          if (!(error instanceof S3ServiceException && /BucketAlready/.test(error.name)))
            throw error;
        });
      this.logger.log(`Created bucket ${this.bucket}`);
    }
    await this.client.send(
      new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [this.config.get('WEB_ORIGIN', { infer: true })],
              AllowedMethods: ['PUT', 'GET'],
              AllowedHeaders: ['content-type', 'content-disposition'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
  }
}
