'use client';

import type { ThreadSummary } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { useAiJob, useAiStatus, useIssueSummary, useRequestSummary } from '@/lib/queries/ai';

function List({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h4>
      <ul className="mt-1 list-disc space-y-0.5 pl-5">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function SummaryBody({ summary }: { summary: ThreadSummary }) {
  return (
    <div className="grid gap-3 text-sm">
      <p>{summary.tldr}</p>
      <List title="Decisions" items={summary.keyDecisions} />
      <List title="Open questions" items={summary.openQuestions} />
      <List title="Next steps" items={summary.nextSteps} />
    </div>
  );
}

/** AI summary of the issue and its comments (FR-7.2). Made in the background; cached per thread. */
export function SummaryPanel({ issueId, canRequest }: { issueId: string; canRequest: boolean }) {
  const { data: status } = useAiStatus();
  const { data: summary, isPending, isError } = useIssueSummary(issueId);
  const request = useRequestSummary(issueId);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: job } = useAiJob(jobId, issueId);

  const available = status?.available ?? false;
  const jobRunning = jobId !== null && job?.status !== 'COMPLETED' && job?.status !== 'FAILED';
  const working = request.isPending || jobRunning;
  const failure =
    error ?? (job?.status === 'FAILED' ? (job.error ?? 'The summary could not be made.') : null);

  const summarise = async () => {
    setError(null);
    try {
      const result = await request.mutateAsync();
      if (result.status === 'queued') setJobId(result.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The summary could not be requested.');
    }
  };

  const action = canRequest && available && (
    <Button variant="ghost" size="sm" onClick={() => void summarise()} disabled={working}>
      {summary ? <RefreshCw aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
      {summary ? 'Update summary' : 'Summarise thread'}
    </Button>
  );

  return (
    <section aria-labelledby="ai-summary-heading" className="grid gap-2">
      <div className="flex items-center justify-between">
        <h3 id="ai-summary-heading" className="flex items-center gap-1.5 text-sm font-semibold">
          <Sparkles className="size-4" aria-hidden="true" />
          AI summary
        </h3>
        {(!summary || summary.stale) && action}
      </div>

      {working && (
        <p role="status" className="text-sm text-muted-foreground">
          Summarising the thread… You can leave this page; you will get a notification.
        </p>
      )}
      {failure && !working && (
        <Alert variant="destructive" role="alert">
          {failure}
        </Alert>
      )}

      {isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-muted-foreground">The summary could not be loaded.</p>
      ) : summary ? (
        <div className="grid gap-2 rounded-lg border p-3">
          <p className="text-xs text-muted-foreground">
            AI-generated from the thread on {new Date(summary.generatedAt).toLocaleString()}. Check
            important details against the comments.
            {summary.stale && (
              <strong className="ml-1 font-medium text-foreground">
                Out of date: the issue or its comments changed since.
              </strong>
            )}
          </p>
          <SummaryBody summary={summary.summary} />
        </div>
      ) : (
        !working && (
          <p className="text-sm text-muted-foreground">
            {available
              ? 'No summary yet.'
              : 'The AI assistant is unavailable right now. Everything else works as usual.'}
          </p>
        )
      )}
    </section>
  );
}
