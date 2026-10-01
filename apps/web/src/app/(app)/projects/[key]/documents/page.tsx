'use client';

import { Badge } from '@forge/ui/components/badge';
import { Button } from '@forge/ui/components/button';
import { Skeleton } from '@forge/ui/components/skeleton';
import { FileText, Trash2 } from 'lucide-react';
import Link from 'next/link';

import { ConfirmDialog } from '@/components/confirm-dialog';
import { UploadDocumentDialog } from '@/components/documents/upload-document-dialog';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { useDeleteDocument, useDocuments } from '@/lib/queries/search';

const size = (bytes: number) =>
  bytes < 1024 ? `${String(bytes)} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} kB`;

export default function DocumentsPage() {
  const project = useCurrentProject();
  const canWrite = useCan('document:write') && !project.archivedAt;
  const { data: documents, isPending, isError } = useDocuments(project.id);
  const remove = useDeleteDocument(project.id);

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground">
          Engineering documents the assistant and search can cite.
        </p>
        {canWrite && <UploadDocumentDialog projectId={project.id} />}
      </div>
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <p className="text-sm text-destructive">Documents could not be loaded.</p>
      ) : documents.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          No documents yet.
        </div>
      ) : (
        <ul className="grid gap-2">
          {documents.map((doc) => (
            <li key={doc.id} className="flex items-center gap-3 rounded-lg border p-3">
              <FileText className="size-5 text-muted-foreground" aria-hidden="true" />
              <div className="grid min-w-0 flex-1 gap-0.5">
                <Link
                  href={`/projects/${project.key}/documents/${doc.id}`}
                  className="truncate font-medium hover:underline"
                >
                  {doc.title}
                </Link>
                <p className="text-xs text-muted-foreground">
                  {size(doc.sizeBytes)} · {doc.createdBy?.displayName ?? 'a former member'} ·{' '}
                  {new Date(doc.createdAt).toLocaleDateString()}
                </p>
              </div>
              {doc.indexedAt ? (
                <Badge variant="outline">
                  {doc.chunkCount} {doc.chunkCount === 1 ? 'section' : 'sections'} indexed
                </Badge>
              ) : (
                <Badge variant="secondary" role="status">
                  Indexing…
                </Badge>
              )}
              {canWrite && (
                <ConfirmDialog
                  trigger={(open) => (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${doc.title}`}
                      onClick={open}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  )}
                  title="Delete document?"
                  description={`“${doc.title}” will no longer be searchable or cited.`}
                  confirmLabel="Delete"
                  destructive
                  onConfirm={() => remove.mutateAsync(doc.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
