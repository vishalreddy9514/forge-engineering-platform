'use client';

import { DocumentSourceType, SOURCE_TYPE_LABELS } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Input } from '@forge/ui/components/input';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { Skeleton } from '@forge/ui/components/skeleton';
import { cn } from '@forge/ui/lib/utils';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type SyntheticEvent, useState } from 'react';

import { useAiStatus } from '@/lib/queries/ai';
import { useProjects } from '@/lib/queries/projects';
import { useSemanticSearch } from '@/lib/queries/search';

import { SourceIcon, SourceLink } from './source-link';

/**
 * FR-11.2: search by meaning across issues, comments, pull requests, commits and documents in
 * every project the user can read. The query lives in the URL, so a search can be shared.
 */
export function SemanticSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = params.get('q') ?? '';
  const projectId = params.get('project') ?? undefined;
  const types = params
    .getAll('type')
    .filter((t): t is DocumentSourceType => DocumentSourceType.safeParse(t).success);
  const [draft, setDraft] = useState(q);
  const { data: status } = useAiStatus();
  const { data: projects } = useProjects({ archived: false });
  const { data, isFetching, error } = useSemanticSearch(q, projectId, types);

  const navigate = (next: {
    q?: string;
    project?: string | null;
    types?: DocumentSourceType[];
  }) => {
    const search = new URLSearchParams();
    const query = next.q ?? q;
    const project = next.project === undefined ? projectId : next.project;
    if (query) search.set('q', query);
    if (project) search.set('project', project);
    for (const type of next.types ?? types) search.append('type', type);
    router.replace(`${pathname}?${search.toString()}`);
  };
  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    navigate({ q: draft.trim() });
  };
  const toggle = (type: DocumentSourceType) => {
    navigate({ types: types.includes(type) ? types.filter((t) => t !== type) : [...types, type] });
  };

  if (status && !status.available) {
    return (
      <Alert>
        Search by meaning is unavailable right now. Keyword search on each project&apos;s issue list
        still works.
      </Alert>
    );
  }

  const results = data?.data ?? [];
  return (
    <div className="grid gap-5">
      <form role="search" onSubmit={submit} className="grid gap-3">
        <Label htmlFor="semantic-q">
          Search issues, comments, pull requests, commits and documents
        </Label>
        <div className="flex gap-2">
          <Input
            id="semantic-q"
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
            }}
            placeholder="e.g. why were customers charged twice?"
            autoFocus
          />
          <Select
            aria-label="Project"
            value={projectId ?? ''}
            onChange={(event) => {
              navigate({ project: event.target.value || null });
            }}
            className="w-48"
          >
            <option value="">All my projects</option>
            {projects?.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} · {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Source types">
          {DocumentSourceType.options.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={types.includes(type)}
              onClick={() => {
                toggle(type);
              }}
              className={cn(
                'rounded-full border px-3 py-0.5 text-xs',
                types.includes(type)
                  ? 'border-foreground bg-foreground text-background'
                  : 'text-muted-foreground',
              )}
            >
              {SOURCE_TYPE_LABELS[type]}
            </button>
          ))}
        </div>
      </form>

      {error ? (
        <Alert variant="destructive">{error.message}</Alert>
      ) : q.trim().length < 2 ? (
        <p className="text-sm text-muted-foreground">
          Ask in your own words: results match meaning as well as exact words like issue keys.
        </p>
      ) : isFetching && !data ? (
        <Skeleton className="h-40" />
      ) : results.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches “{q}”.</p>
      ) : (
        <ol aria-label="Search results" aria-busy={isFetching} className="grid gap-3">
          {results.map((r) => (
            <li key={r.documentId} className="grid gap-1 rounded-lg border p-3">
              <p className="flex items-center gap-2 text-sm font-medium">
                <SourceIcon type={r.sourceType} />
                <SourceLink url={r.url}>{r.title}</SourceLink>
                <span className="ml-auto font-mono text-xs text-muted-foreground">
                  {r.projectKey}
                </span>
              </p>
              {r.headingPath && <p className="text-xs text-muted-foreground">{r.headingPath}</p>}
              <p className="line-clamp-3 text-sm text-muted-foreground">{r.snippet}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
