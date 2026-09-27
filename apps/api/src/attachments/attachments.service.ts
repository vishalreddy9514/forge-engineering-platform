import {
  type Attachment,
  type AttachmentUpload,
  type CreateAttachmentRequest,
  type DownloadUrl,
  MAX_ATTACHMENTS_PER_ISSUE,
} from '@forge/types';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import type { ProjectAccess } from '../access-control/project-access.guard';
import { can } from '../access-control/permissions';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { StorageService } from '../infrastructure/storage/storage.service';
import { ATTACHMENT_INCLUDE, toAttachment } from './attachment.mapper';
import { attachmentDisposition } from './content-disposition';

/**
 * Attachments upload straight to object storage (FR-4.6):
 * 1. the client asks for an upload and gets a pre-signed PUT for exactly that size and type;
 * 2. it uploads the bytes to storage directly;
 * 3. it confirms, and the API checks the stored object before making it visible.
 * Uploads that are never confirmed are removed by the worker's cleanup job.
 */
@Injectable()
export class AttachmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async requestUpload(
    issueId: string,
    input: CreateAttachmentRequest,
    user: AuthUser,
  ): Promise<AttachmentUpload> {
    const existing = await this.prisma.attachment.count({ where: { issueId } });
    if (existing >= MAX_ATTACHMENTS_PER_ISSUE) {
      throw new ConflictException(
        `An issue can have at most ${MAX_ATTACHMENTS_PER_ISSUE} attachments. Delete one first.`,
      );
    }
    // Random, not derived from the file name: keys never contain user input.
    const storageKey = `issues/${issueId}/${randomUUID()}`;
    const upload = await this.storage.presignUpload(storageKey, {
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      disposition: attachmentDisposition(input.fileName),
    });
    const attachment = await this.prisma.attachment.create({
      data: {
        issueId,
        uploadedById: user.id,
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: input.sizeBytes,
        storageKey,
      },
      include: ATTACHMENT_INCLUDE,
    });
    return {
      attachment: toAttachment(attachment),
      upload: {
        url: upload.url,
        method: 'PUT',
        headers: upload.headers,
        expiresAt: upload.expiresAt.toISOString(),
      },
    };
  }

  /** Makes an uploaded file visible after checking what storage actually holds. Idempotent. */
  async complete(attachmentId: string, user: AuthUser): Promise<Attachment> {
    const row = await this.prisma.attachment.findUniqueOrThrow({
      where: { id: attachmentId },
      include: ATTACHMENT_INCLUDE,
    });
    if (row.uploadedById !== user.id) {
      throw new ForbiddenException('Only the person uploading a file can complete the upload');
    }
    if (row.status === 'AVAILABLE') return toAttachment(row);

    const stored = await this.storage.stat(row.storageKey);
    if (!stored) {
      throw new ConflictException('The file has not been uploaded yet');
    }
    if (stored.sizeBytes !== row.sizeBytes || stored.contentType !== row.contentType) {
      // Storage enforces the signed size and type, so this means a misbehaving client.
      await this.storage.delete(row.storageKey);
      await this.prisma.attachment.delete({ where: { id: row.id } });
      throw new BadRequestException('The uploaded file does not match the upload request');
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.attachment.updateMany({
        where: { id: row.id, status: 'PENDING_UPLOAD' },
        data: { status: 'AVAILABLE' },
      });
      if (count === 0) return; // a concurrent call completed it first
      await tx.issueEvent.create({
        data: {
          issueId: row.issueId,
          actorId: user.id,
          type: 'ATTACHMENT_ADDED',
          newValue: { id: row.id, name: row.fileName },
        },
      });
      await tx.issue.update({ where: { id: row.issueId }, data: { updatedAt: new Date() } });
    });
    return { ...toAttachment(row), status: 'AVAILABLE' };
  }

  async list(issueId: string): Promise<Attachment[]> {
    const rows = await this.prisma.attachment.findMany({
      where: { issueId, status: 'AVAILABLE' },
      include: ATTACHMENT_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map(toAttachment);
  }

  /** A short-lived link; the API checks access, storage serves the bytes. */
  async downloadUrl(attachmentId: string): Promise<DownloadUrl> {
    const row = await this.prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    if (row.status !== 'AVAILABLE') throw new NotFoundException('Attachment not found');
    const link = await this.storage.presignDownload(
      row.storageKey,
      attachmentDisposition(row.fileName),
    );
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }

  /** The uploader, or anyone who may delete issues (project managers), can remove a file. */
  async delete(attachmentId: string, user: AuthUser, access: ProjectAccess): Promise<void> {
    const row = await this.prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    if (row.uploadedById !== user.id && !can(access.role, 'issue:delete')) {
      throw new ForbiddenException('You can only delete files you uploaded');
    }
    // Storage first: if it fails, the row (and the file) stay and the user can retry.
    await this.storage.delete(row.storageKey);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.attachment.deleteMany({ where: { id: row.id } });
      if (count === 0 || row.status !== 'AVAILABLE') return;
      await tx.issueEvent.create({
        data: {
          issueId: row.issueId,
          actorId: user.id,
          type: 'ATTACHMENT_REMOVED',
          oldValue: { id: row.id, name: row.fileName },
        },
      });
    });
  }
}
