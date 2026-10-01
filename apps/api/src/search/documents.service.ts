import {
  type CreateDocumentRequest,
  type ProjectDocument,
  type ProjectDocumentDetail,
  utf8Length,
} from '@forge/types';
import { Injectable, NotFoundException } from '@nestjs/common';

import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../infrastructure/database/prisma.service';
import { indexLater } from '../outbox/outbox.writer';
import { contentHash, documentUrl } from './source-normaliser';

const SELECT = {
  id: true,
  title: true,
  content: true,
  createdAt: true,
  indexedAt: true,
  createdBy: { select: { id: true, displayName: true } },
  _count: { select: { chunks: true } },
} as const;

type Row = {
  id: string;
  title: string;
  content: string;
  createdAt: Date;
  indexedAt: Date | null;
  createdBy: { id: string; displayName: string } | null;
  _count: { chunks: number };
};

/**
 * Engineering documents uploaded to a project (FR-8.1): Markdown or plain text that the
 * assistant and semantic search can cite, section by section. Each upload is its own document
 * row; indexing is queued through the outbox in the same transaction as the write.
 */
@Injectable()
export class DocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(projectId: string): Promise<ProjectDocument[]> {
    const rows = await this.prisma.document.findMany({
      where: { projectId, sourceType: 'UPLOAD' },
      orderBy: { createdAt: 'desc' },
      select: SELECT,
    });
    return rows.map((row) => toDocument(row));
  }

  async get(projectId: string, documentId: string): Promise<ProjectDocumentDetail> {
    const row = await this.prisma.document.findFirst({
      where: { id: documentId, projectId, sourceType: 'UPLOAD' },
      select: SELECT,
    });
    if (!row) throw new NotFoundException('Document not found');
    return { ...toDocument(row), content: row.content };
  }

  async create(
    projectId: string,
    input: CreateDocumentRequest,
    user: AuthUser,
  ): Promise<ProjectDocument> {
    const project = await this.prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { key: true },
    });
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.document.create({
        data: {
          projectId,
          sourceType: 'UPLOAD',
          title: input.title,
          content: input.content,
          // The URL needs the ID, so it is filled in right after the insert.
          url: '',
          contentHash: contentHash(input),
          createdById: user.id,
        },
        select: { id: true },
      });
      await tx.document.update({
        where: { id: created.id },
        data: { url: documentUrl(project.key, created.id) },
      });
      await indexLater(tx, 'UPLOAD', created.id);
      return tx.document.findUniqueOrThrow({ where: { id: created.id }, select: SELECT });
    });
    return toDocument(row);
  }

  async update(
    projectId: string,
    documentId: string,
    input: CreateDocumentRequest,
  ): Promise<ProjectDocument> {
    const row = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.document.updateMany({
        where: { id: documentId, projectId, sourceType: 'UPLOAD' },
        data: {
          title: input.title,
          content: input.content,
          contentHash: contentHash(input),
          // Searchable as the old text until the new one is embedded; then swapped atomically.
          indexedAt: null,
        },
      });
      if (count === 0) throw new NotFoundException('Document not found');
      await indexLater(tx, 'UPLOAD', documentId);
      return tx.document.findUniqueOrThrow({ where: { id: documentId }, select: SELECT });
    });
    return toDocument(row);
  }

  /** Its chunks go with it (foreign-key cascade), in the same statement. */
  async delete(projectId: string, documentId: string): Promise<void> {
    const { count } = await this.prisma.document.deleteMany({
      where: { id: documentId, projectId, sourceType: 'UPLOAD' },
    });
    if (count === 0) throw new NotFoundException('Document not found');
  }
}

function toDocument(row: Row): ProjectDocument {
  return {
    id: row.id,
    title: row.title,
    sizeBytes: utf8Length(row.content),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    indexedAt: row.indexedAt?.toISOString() ?? null,
    chunkCount: row._count.chunks,
  };
}
