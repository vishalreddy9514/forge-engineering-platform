import type { Attachment } from '@forge/types';

import type { Prisma } from '../generated/prisma/client';
import { toUserSummary, USER_SUMMARY_SELECT } from '../users/user-summary';

export const ATTACHMENT_INCLUDE = {
  uploadedBy: { select: USER_SUMMARY_SELECT },
} as const satisfies Prisma.AttachmentInclude;

type AttachmentRow = Prisma.AttachmentGetPayload<{ include: typeof ATTACHMENT_INCLUDE }>;

export function toAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    issueId: row.issueId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    status: row.status,
    uploadedBy: toUserSummary(row.uploadedBy),
    createdAt: row.createdAt.toISOString(),
  };
}
