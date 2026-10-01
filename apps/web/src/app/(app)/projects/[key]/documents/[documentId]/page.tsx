'use client';

import { Skeleton } from '@forge/ui/components/skeleton';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { Markdown } from '@/components/markdown';
import { useCurrentProject } from '@/components/projects/project-context';
import { useDocument } from '@/lib/queries/search';

export default function DocumentPage() {
  const project = useCurrentProject();
  const { documentId } = useParams<{ documentId: string }>();
  const { data: doc, isPending, isError } = useDocument(project.id, documentId);

  return (
    <article className="grid gap-4">
      <Link
        href={`/projects/${project.key}/documents`}
        className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        All documents
      </Link>
      {isPending ? (
        <Skeleton className="h-64" />
      ) : isError ? (
        <p className="text-sm text-muted-foreground">This document doesn&apos;t exist anymore.</p>
      ) : (
        <>
          <h2 className="text-2xl font-semibold">{doc.title}</h2>
          <Markdown>{doc.content}</Markdown>
        </>
      )}
    </article>
  );
}
