import { type DocumentSourceType, SOURCE_TYPE_LABELS } from '@forge/types';
import {
  FileText,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquare,
  SquareDot,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

const ICONS: Record<DocumentSourceType, typeof FileText> = {
  ISSUE: SquareDot,
  COMMENT: MessageSquare,
  PULL_REQUEST: GitPullRequest,
  COMMIT: GitCommitHorizontal,
  UPLOAD: FileText,
};

export function SourceIcon({ type }: { type: DocumentSourceType }) {
  const Icon = ICONS[type];
  return (
    <Icon className="size-4 shrink-0 text-muted-foreground" aria-label={SOURCE_TYPE_LABELS[type]} />
  );
}

/** Forge pages open in place; GitHub links open in a new tab. */
export function SourceLink({ url, children }: { url: string; children: ReactNode }) {
  if (url.startsWith('/')) {
    return (
      <Link href={url} className="underline-offset-2 hover:underline">
        {children}
      </Link>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}
