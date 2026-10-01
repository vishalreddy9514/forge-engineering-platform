'use client';

import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { relatedToDraft } from '@/lib/queries/search';

import { RelatedIssueList } from './related-issues';

/** Waits until typing pauses before looking for duplicates (one embedding per pause). */
export const DUPLICATE_DEBOUNCE_MS = 700;
const MIN_LENGTH = 10;

function useDebounced(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return debounced;
}

/**
 * FR-7.3 while drafting: existing issues that read like the one being written, so a duplicate
 * is noticed before it is created. Silent when there are none or the AI is unavailable.
 */
export function DuplicateHints({
  projectId,
  projectKey,
  text,
}: {
  projectId: string;
  projectKey: string;
  text: string;
}) {
  const debounced = useDebounced(text.trim(), DUPLICATE_DEBOUNCE_MS);
  const { data } = useQuery({
    queryKey: ['search', 'duplicates', projectId, debounced],
    queryFn: ({ signal }) => relatedToDraft(projectId, debounced, signal),
    enabled: debounced.length >= MIN_LENGTH,
    staleTime: 60_000,
    retry: false,
  });
  const issues = data?.data ?? [];
  if (debounced.length < MIN_LENGTH || issues.length === 0) return null;

  return (
    <div role="status" className="grid gap-2 rounded-md border bg-muted/40 p-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <Copy className="size-4" aria-hidden="true" />
        Possible duplicates
      </p>
      <RelatedIssueList issues={issues} projectKey={projectKey} />
    </div>
  );
}
