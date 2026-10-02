import type { Citation } from '@forge/types';
import { Fragment } from 'react';

import { SourceIcon, SourceLink } from './source-link';

const CITATION = /\[(\d{1,3})\]/g;

/** Splits an answer into text and citation markers ([2]), keeping their order. */
export function splitCitations(answer: string): (string | number)[] {
  const parts: (string | number)[] = [];
  let last = 0;
  for (const match of answer.matchAll(CITATION)) {
    if (match.index > last) parts.push(answer.slice(last, match.index));
    parts.push(Number(match[1]));
    last = match.index + match[0].length;
  }
  if (last < answer.length) parts.push(answer.slice(last));
  return parts;
}

/**
 * An assistant answer with its sources (FR-8.5): each [n] links to the source it cites, and the
 * sources are listed underneath. A number with no matching source is shown as plain text.
 */
export function CitedAnswer({ answer, citations }: { answer: string; citations: Citation[] }) {
  const byNumber = new Map(citations.map((c) => [c.n, c]));
  return (
    <div className="grid gap-3">
      <p className="text-sm leading-relaxed whitespace-pre-wrap">
        {splitCitations(answer).map((part, i) => {
          if (typeof part === 'string') return <Fragment key={i}>{part}</Fragment>;
          const citation = byNumber.get(part);
          if (!citation) return <Fragment key={i}>[{part}]</Fragment>;
          return (
            <sup key={i} className="mx-0.5">
              <SourceLink url={citation.url}>
                <span aria-label={`Source ${String(part)}: ${citation.title}`}>[{part}]</span>
              </SourceLink>
            </sup>
          );
        })}
      </p>
      {citations.length > 0 && (
        <ol aria-label="Sources" className="grid gap-1 border-t pt-2 text-xs">
          {citations.map((c) => (
            <li key={c.n} className="flex items-center gap-2">
              <span className="w-6 text-muted-foreground">[{c.n}]</span>
              <SourceIcon type={c.sourceType} />
              <SourceLink url={c.url}>
                {c.title}
                {c.headingPath && <span className="text-muted-foreground"> › {c.headingPath}</span>}
              </SourceLink>
              {c.projectKey && (
                <span className="font-mono text-muted-foreground">{c.projectKey}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
