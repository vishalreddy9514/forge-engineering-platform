'use client';

import { IssueStatus, STATUS_LABELS } from '@forge/types';
import { Input } from '@forge/ui/components/input';
import { Select } from '@forge/ui/components/select';
import { Skeleton } from '@forge/ui/components/skeleton';
import { useDeferredValue, useState } from 'react';

import { CreateIssueDialog } from '@/components/issues/create-issue-dialog';
import { IssueList } from '@/components/issues/issue-list';
import { useCan, useCurrentProject } from '@/components/projects/project-context';
import { type IssueFilters, useIssues } from '@/lib/queries/issues';

const OPEN_STATUSES = IssueStatus.options.filter((s) => s !== 'DONE' && s !== 'CANCELLED');

export default function IssuesPage() {
  const project = useCurrentProject();
  const canCreate = useCan('issue:create');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<string>('open');
  const [mine, setMine] = useState(false);
  const [sort, setSort] = useState<NonNullable<IssueFilters['sort']>>('updated');
  const q = useDeferredValue(search.trim());

  const filters: IssueFilters = {
    q: q || undefined,
    status: status === 'open' ? OPEN_STATUSES : status === 'all' ? undefined : [status],
    assignee: mine ? 'me' : undefined,
    sort,
  };
  const { data, isPending, isError } = useIssues(project.id, filters);

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          aria-label="Search issues"
          placeholder="Search issues…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          className="max-w-xs"
        />
        <Select
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
          }}
        >
          <option value="open">Open issues</option>
          <option value="all">All statuses</option>
          {IssueStatus.options.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Sort"
          value={sort}
          onChange={(e) => {
            setSort(e.target.value as NonNullable<IssueFilters['sort']>);
          }}
        >
          <option value="updated">Recently updated</option>
          <option value="created">Newest</option>
          <option value="priority">Priority</option>
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={mine}
            onChange={(e) => {
              setMine(e.target.checked);
            }}
          />
          Assigned to me
        </label>
        <div className="ml-auto">{canCreate && <CreateIssueDialog />}</div>
      </div>

      {isError && <p role="alert">Could not load issues.</p>}
      {isPending && <Skeleton className="h-64" />}
      {data?.data.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          {q || status !== 'open' || mine
            ? 'No issues match these filters.'
            : 'No open issues. Nice.'}
        </div>
      )}
      {data && data.data.length > 0 && <IssueList issues={data.data} projectKey={project.key} />}
      {data?.nextCursor && (
        <p className="text-center text-sm text-muted-foreground">
          Showing the first {data.data.length} issues. Narrow the filters to see more.
        </p>
      )}
    </div>
  );
}
