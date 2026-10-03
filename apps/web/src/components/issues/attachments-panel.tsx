'use client';

import { formatBytes } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Download, FileText, Paperclip, Trash2 } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';

import { useAuth } from '@/components/auth/auth-provider';
import {
  downloadAttachment,
  useAttachments,
  useDeleteAttachment,
  useUploadAttachment,
  validateFile,
} from '@/lib/queries/attachments';

interface AttachmentsPanelProps {
  issue: { id: string };
  canUpload: boolean;
  /** Project managers can delete anyone's files; everyone else only their own. */
  canDeleteAny: boolean;
}

export function AttachmentsPanel({ issue, canUpload, canDeleteAny }: AttachmentsPanelProps) {
  const { state } = useAuth();
  const { data: attachments, isPending, isError } = useAttachments(issue.id);
  const upload = useUploadAttachment(issue);
  const remove = useDeleteAttachment(issue);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ name: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFiles = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = ''; // allow choosing the same file again
    setError(null);
    for (const file of files) {
      const problem = validateFile(file);
      if (problem) {
        setError(problem);
        continue;
      }
      setProgress({ name: file.name, fraction: 0 });
      try {
        await upload.mutateAsync({
          file,
          onProgress: (fraction) => {
            setProgress({ name: file.name, fraction });
          },
        });
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`);
      }
    }
    setProgress(null);
  };

  const onDownload = (id: string) => {
    setError(null);
    downloadAttachment(id).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : 'The file could not be downloaded.');
    });
  };

  return (
    <section aria-labelledby="attachments-heading" className="grid gap-2">
      <div className="flex items-center justify-between">
        <h3 id="attachments-heading" className="text-sm font-semibold">
          Attachments{attachments && attachments.length > 0 && ` (${String(attachments.length)})`}
        </h3>
        {canUpload && (
          <>
            <input
              ref={input}
              id="attachment-input"
              type="file"
              multiple
              // Not shown or focusable: the "Attach files" button below opens it.
              hidden
              onChange={(e) => void onFiles(e)}
            />
            <Button
              variant="ghost"
              size="sm"
              disabled={progress !== null}
              onClick={() => input.current?.click()}
            >
              <Paperclip aria-hidden="true" />
              Attach files
            </Button>
          </>
        )}
      </div>

      {error && <Alert variant="destructive">{error}</Alert>}
      {progress && (
        <div role="status" className="grid gap-1 text-sm">
          <span>
            Uploading {progress.name}… {Math.round(progress.fraction * 100)}%
          </span>
          <progress max={1} value={progress.fraction} className="h-1.5 w-full" />
        </div>
      )}

      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading attachments…</p>
      ) : isError ? (
        <Alert variant="destructive">Attachments could not be loaded.</Alert>
      ) : attachments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No attachments.</p>
      ) : (
        <ul className="grid gap-1">
          {attachments.map((file) => {
            const mine = file.uploadedBy.id === state.user?.id;
            return (
              <li
                key={file.id}
                className="flex items-center gap-3 rounded-lg border px-3 py-2 text-sm"
              >
                <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="grid min-w-0 flex-1">
                  <span className="truncate font-medium">{file.fileName}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(file.sizeBytes)} · {file.uploadedBy.displayName} ·{' '}
                    {new Date(file.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Download ${file.fileName}`}
                  onClick={() => {
                    onDownload(file.id);
                  }}
                >
                  <Download aria-hidden="true" />
                </Button>
                {canUpload && (mine || canDeleteAny) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${file.fileName}`}
                    disabled={remove.isPending}
                    onClick={() => {
                      if (!window.confirm(`Delete ${file.fileName}?`)) return;
                      setError(null);
                      remove.mutateAsync(file.id).catch((e: unknown) => {
                        setError(e instanceof Error ? e.message : 'The file could not be deleted.');
                      });
                    }}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
