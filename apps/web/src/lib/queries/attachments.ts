import {
  Attachment,
  attachmentContentType,
  AttachmentUpload,
  DownloadUrl,
  MAX_ATTACHMENT_BYTES,
} from '@forge/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiFetch, apiJson } from '@/lib/api';
import { putFile } from '@/lib/upload';

import { issueKeys } from './issues';

export const attachmentKeys = {
  list: (issueId: string) => ['issues', issueId, 'attachments'] as const,
};

export function useAttachments(issueId: string) {
  return useQuery({
    queryKey: attachmentKeys.list(issueId),
    queryFn: () => apiJson(`/issues/${issueId}/attachments`, z.array(Attachment)),
  });
}

/** Checks a file before any request, with the same rules the API applies. */
export function validateFile(file: File): string | null {
  if (file.size === 0) return `${file.name} is empty.`;
  if (file.size > MAX_ATTACHMENT_BYTES) return `${file.name} is larger than 10 MB.`;
  if (!attachmentContentType(file)) {
    return `${file.name} is not an allowed file type. Use an image, PDF, text, CSV, Markdown, JSON or archive.`;
  }
  return null;
}

/** Request → upload straight to storage → confirm. */
export function useUploadAttachment(issue: { id: string }) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, onProgress }: { file: File; onProgress?: (f: number) => void }) => {
      const contentType = attachmentContentType(file);
      if (!contentType) throw new Error(validateFile(file) ?? 'This file type is not allowed.');
      const { attachment, upload } = await apiJson(
        `/issues/${issue.id}/attachments`,
        AttachmentUpload,
        {
          method: 'POST',
          body: JSON.stringify({ fileName: file.name, contentType, sizeBytes: file.size }),
        },
      );
      await putFile(upload, file, onProgress);
      return apiJson(`/attachments/${attachment.id}/complete`, Attachment, { method: 'POST' });
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: attachmentKeys.list(issue.id) });
      void client.invalidateQueries({ queryKey: issueKeys.events(issue.id) });
    },
  });
}

export function useDeleteAttachment(issue: { id: string }) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (attachmentId: string) =>
      apiFetch(`/attachments/${attachmentId}`, { method: 'DELETE' }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: attachmentKeys.list(issue.id) });
      void client.invalidateQueries({ queryKey: issueKeys.events(issue.id) });
    },
  });
}

/** Download links last a minute, so they are fetched on click rather than rendered. */
export async function downloadAttachment(attachmentId: string): Promise<void> {
  const { url } = await apiJson(`/attachments/${attachmentId}/download`, DownloadUrl);
  window.location.assign(url);
}
