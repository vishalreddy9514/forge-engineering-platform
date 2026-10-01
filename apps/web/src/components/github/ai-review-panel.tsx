'use client';

import {
  type PullRequestReview,
  REVIEW_DISCLAIMER,
  type ReviewFinding,
  type ReviewSeverity,
  reviewToMarkdown,
} from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Badge } from '@forge/ui/components/badge';
import { Button } from '@forge/ui/components/button';
import { Skeleton } from '@forge/ui/components/skeleton';
import { cn } from '@forge/ui/lib/utils';
import { ClipboardCopy, RefreshCw, ScanSearch, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { useAiStatus } from '@/lib/queries/ai';
import { useRequestReview, useReview, useReviewJob } from '@/lib/queries/reviews';

const SEVERITY_STYLE: Record<ReviewSeverity, string> = {
  critical: 'border-destructive bg-destructive text-white',
  major: 'border-orange-600 text-orange-700 dark:text-orange-400',
  minor: 'border-amber-500 text-amber-700 dark:text-amber-400',
  nit: 'text-muted-foreground',
};
const SEVERITIES: ReviewSeverity[] = ['critical', 'major', 'minor', 'nit'];

export function SeverityBadge({ severity }: { severity: ReviewSeverity }) {
  return (
    <Badge variant="outline" className={cn('uppercase', SEVERITY_STYLE[severity])}>
      {severity}
    </Badge>
  );
}

/** Findings grouped by file, in the order they were ranked (most severe first). */
export function groupByFile(findings: ReviewFinding[]): [string, ReviewFinding[]][] {
  const groups = new Map<string, ReviewFinding[]>();
  for (const finding of findings) {
    groups.set(finding.file, [...(groups.get(finding.file) ?? []), finding]);
  }
  return [...groups.entries()];
}

function ReviewBody({ review, filesUrl }: { review: PullRequestReview; filesUrl: string }) {
  const [copied, setCopied] = useState(false);
  const counts = SEVERITIES.map(
    (s) => [s, review.findings.filter((f) => f.severity === s).length] as const,
  ).filter(([, n]) => n > 0);

  const copy = async () => {
    await navigator.clipboard.writeText(reviewToMarkdown(review));
    setCopied(true);
  };

  return (
    <div className="grid gap-4 text-sm">
      <p className="leading-relaxed">{review.summary}</p>
      <div className="flex flex-wrap items-center gap-2">
        {counts.length === 0 ? (
          <span className="text-muted-foreground">No findings.</span>
        ) : (
          counts.map(([severity, n]) => (
            <span key={severity} className="flex items-center gap-1">
              <SeverityBadge severity={severity} /> × {n}
            </span>
          ))
        )}
        <Button variant="outline" size="sm" className="ml-auto" onClick={() => void copy()}>
          <ClipboardCopy aria-hidden="true" />
          {copied ? 'Copied' : 'Copy as Markdown'}
        </Button>
      </div>

      {groupByFile(review.findings).map(([file, findings]) => (
        <section
          key={file}
          aria-label={`Findings in ${file}`}
          className="grid gap-2 rounded-lg border p-3"
        >
          <h4 className="font-mono text-xs">
            <a
              href={filesUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:underline"
            >
              {file}
            </a>
          </h4>
          <ul className="grid gap-3">
            {findings.map((f, i) => (
              <li key={`${String(f.line)}-${String(i)}`} className="grid gap-1">
                <p className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={f.severity} />
                  <span className="text-xs text-muted-foreground">{f.category}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {f.line === null ? 'whole file' : `line ${String(f.line)}`}
                  </span>
                </p>
                <p>{f.explanation}</p>
                {f.suggestion && (
                  <p className="text-muted-foreground">Suggestion: {f.suggestion}</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {review.missingTests.length > 0 && (
        <section aria-labelledby="missing-tests-heading" className="grid gap-1">
          <h4 id="missing-tests-heading" className="font-semibold">
            Missing tests
          </h4>
          <ul className="list-disc space-y-0.5 pl-5">
            {review.missingTests.map((t) => (
              <li key={t.description}>
                {t.description}
                {t.file && (
                  <span className="font-mono text-xs text-muted-foreground"> ({t.file})</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          {review.files.length} file(s) reviewed, {review.skippedFiles.length} skipped
        </summary>
        <ul className="mt-2 grid gap-1">
          {review.files.map((f) => (
            <li key={f.path}>
              <span className="font-mono">{f.path}</span>:{' '}
              {f.status === 'failed' ? 'could not be reviewed' : f.summary}
            </li>
          ))}
          {review.skippedFiles.map((f) => (
            <li key={f.path}>
              <span className="font-mono">{f.path}</span>: skipped ({f.reason})
            </li>
          ))}
        </ul>
      </details>
      <p className="text-xs text-muted-foreground">
        Commit <span className="font-mono">{review.headSha.slice(0, 7)}</span> · {review.model} ·{' '}
        {new Date(review.createdAt).toLocaleString()}
      </p>
    </div>
  );
}

/**
 * FR-9.3: the AI review of a pull request, made in the background and stored per commit. Always
 * labelled as suggestions; Forge never posts it to GitHub (a person can copy it there).
 */
export function AiReviewPanel({
  projectId,
  pullRequestId,
  filesUrl,
  canRequest,
}: {
  projectId: string;
  pullRequestId: string;
  filesUrl: string;
  canRequest: boolean;
}) {
  const { data: status } = useAiStatus();
  const { data: review, isPending, isError } = useReview(projectId, pullRequestId);
  const request = useRequestReview(projectId, pullRequestId);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: job } = useReviewJob(jobId, projectId, pullRequestId);

  const available = status?.available ?? false;
  const running = jobId !== null && job?.status !== 'COMPLETED' && job?.status !== 'FAILED';
  const working = request.isPending || running;
  const failure =
    error ?? (job?.status === 'FAILED' ? (job.error ?? 'The review could not be made.') : null);
  const canAsk = canRequest && available && (!review || review.stale) && !working;

  const start = async () => {
    setError(null);
    try {
      const result = await request.mutateAsync();
      if (result.status === 'queued') setJobId(result.job.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The review could not be requested.');
    }
  };

  return (
    <section aria-labelledby="ai-review-heading" className="grid gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="ai-review-heading" className="flex items-center gap-1.5 font-semibold">
          <ScanSearch className="size-4" aria-hidden="true" />
          AI review
        </h3>
        {canAsk && (
          <Button size="sm" onClick={() => void start()}>
            {review?.stale ? <RefreshCw aria-hidden="true" /> : <ScanSearch aria-hidden="true" />}
            {review?.stale ? 'Review latest commit' : 'Review with AI'}
          </Button>
        )}
      </div>
      <Alert>
        <TriangleAlert className="mr-1 inline size-4" aria-hidden="true" />
        {REVIEW_DISCLAIMER}
      </Alert>
      {working && (
        <p role="status" className="text-sm text-muted-foreground">
          Reviewing the changes… this can take a minute. You&apos;ll get a notification when
          it&apos;s ready.
        </p>
      )}
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
      {review?.stale && (
        <p className="text-sm text-muted-foreground">
          New commits were pushed after this review of{' '}
          <span className="font-mono">{review.headSha.slice(0, 7)}</span>.
        </p>
      )}
      {isPending ? (
        <Skeleton className="h-24" />
      ) : isError ? (
        <p className="text-sm text-muted-foreground">The review could not be loaded.</p>
      ) : review ? (
        <ReviewBody review={review} filesUrl={filesUrl} />
      ) : (
        !working && (
          <p className="text-sm text-muted-foreground">
            {available
              ? 'Not reviewed yet.'
              : 'AI review is unavailable right now. Everything else still works.'}
          </p>
        )
      )}
    </section>
  );
}
