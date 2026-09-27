import { z } from 'zod';

import { UserSummary } from './projects';

/** FR-4.6. The database enforces the same limit with a CHECK constraint. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_ISSUE = 50;

/**
 * Content types that may be uploaded. Deliberately excludes HTML, SVG and anything executable:
 * files are served from the storage origin, but a script-capable type is never worth the risk.
 * Every file is downloaded with `Content-Disposition: attachment`.
 */
export const ATTACHMENT_CONTENT_TYPES = {
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/gif': ['gif'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
  'text/plain': ['txt', 'log'],
  'text/csv': ['csv'],
  'text/markdown': ['md', 'markdown'],
  'application/json': ['json'],
  'application/zip': ['zip'],
  'application/gzip': ['gz', 'tgz'],
} as const satisfies Record<string, readonly string[]>;

export type AttachmentContentType = keyof typeof ATTACHMENT_CONTENT_TYPES;
const CONTENT_TYPES = Object.keys(ATTACHMENT_CONTENT_TYPES) as [
  AttachmentContentType,
  ...AttachmentContentType[],
];

/** Declared types that can run script if rendered: refused whatever the extension says. */
const SCRIPT_CAPABLE = /html|svg|xml|javascript|ecmascript/;

/**
 * The content type to declare for a file. Browsers report many types inconsistently: empty for
 * .md, "text/x-log" for .log, "application/vnd.ms-excel" for .csv on Windows. So an allowed
 * declared type wins, and otherwise the extension decides. The type that is stored and served
 * always comes from the allow-list, never from the browser. Null means not allowed.
 */
export function attachmentContentType(file: {
  name: string;
  type: string;
}): AttachmentContentType | null {
  const declared = file.type.split(';')[0]?.trim().toLowerCase() ?? '';
  if (declared in ATTACHMENT_CONTENT_TYPES) return declared as AttachmentContentType;
  if (SCRIPT_CAPABLE.test(declared)) return null;
  const extension = file.name.toLowerCase().split('.').pop() ?? '';
  for (const [type, extensions] of Object.entries(ATTACHMENT_CONTENT_TYPES)) {
    if ((extensions as readonly string[]).includes(extension)) {
      return type as AttachmentContentType;
    }
  }
  return null;
}

/**
 * A safe display name: no path, no control characters, no characters that break headers.
 * Returns '' when nothing usable is left.
 */
export function sanitizeFileName(name: string): string {
  return (
    name
      .split(/[/\\]/)
      .pop()
      // eslint-disable-next-line no-control-regex
      ?.replace(/[\u0000-\u001f\u007f"]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 255) ?? ''
  );
}

export const CreateAttachmentRequest = z.object({
  fileName: z.string().transform(sanitizeFileName).pipe(z.string().min(1, 'The file needs a name')),
  contentType: z.enum(CONTENT_TYPES, {
    message:
      'This file type is not allowed. Use an image, PDF, text, CSV, Markdown, JSON or archive',
  }),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'The file is empty')
    .max(MAX_ATTACHMENT_BYTES, 'Files can be at most 10 MB'),
});
export type CreateAttachmentRequest = z.infer<typeof CreateAttachmentRequest>;

export const Attachment = z.object({
  id: z.uuid(),
  issueId: z.uuid(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(['PENDING_UPLOAD', 'AVAILABLE']),
  uploadedBy: UserSummary,
  createdAt: z.string(),
});
export type Attachment = z.infer<typeof Attachment>;

/** Response to an upload request: PUT the file bytes to `upload.url` with `upload.headers`. */
export const AttachmentUpload = z.object({
  attachment: Attachment,
  upload: z.object({
    url: z.url(),
    method: z.literal('PUT'),
    headers: z.record(z.string(), z.string()),
    expiresAt: z.string(),
  }),
});
export type AttachmentUpload = z.infer<typeof AttachmentUpload>;

export const DownloadUrl = z.object({ url: z.url(), expiresAt: z.string() });
export type DownloadUrl = z.infer<typeof DownloadUrl>;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
