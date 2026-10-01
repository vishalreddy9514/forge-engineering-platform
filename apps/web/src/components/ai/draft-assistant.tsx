'use client';

import {
  draftToDescription,
  type IssuePriority,
  type IssueType,
  type Label as ProjectLabel,
  PRIORITY_LABELS,
} from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Label } from '@forge/ui/components/label';
import { Textarea } from '@forge/ui/components/textarea';
import { Sparkles, Square } from 'lucide-react';
import { useRef, useState } from 'react';

import { type DraftOutcome, streamDraft } from '@/lib/queries/ai';

export interface DraftValues {
  title: string;
  description: string;
  type: IssueType;
  priority: IssuePriority;
  labelIds: string[];
}

interface DraftAssistantProps {
  projectId: string;
  labels: ProjectLabel[];
  onApply: (values: DraftValues) => void;
}

/** The title as it is being written, from the partial JSON the model has produced so far. */
export function partialTitle(soFar: string): string | null {
  const match = /"title"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(soFar);
  if (!match) return null;
  try {
    return JSON.parse(`"${match[1] ?? ''}"`) as string;
  } catch {
    return match[1] ?? null; // cut inside an escape sequence
  }
}

/**
 * "Draft with AI" (FR-7.1): turns a rough description into a structured issue and fills the
 * form with it. It only fills the form; the person reviews, edits and creates the issue.
 */
export function DraftAssistant({ projectId, labels, onApply }: DraftAssistantProps) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [live, setLive] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<DraftOutcome | null>(null);
  const abort = useRef<AbortController | null>(null);

  const generate = async () => {
    if (text.trim().length < 10) {
      setError('Describe the problem or request in at least a sentence.');
      return;
    }
    setError(null);
    setApplied(null);
    setLive('');
    setStreaming(true);
    abort.current = new AbortController();
    try {
      const outcome = await streamDraft(projectId, text, setLive, abort.current.signal);
      const byName = new Map(labels.map((l) => [l.name, l.id]));
      onApply({
        title: outcome.draft.title,
        description: draftToDescription(outcome.draft),
        type: outcome.draft.type,
        priority: outcome.draft.priority,
        labelIds: outcome.draft.labels.flatMap((name) => byName.get(name) ?? []),
      });
      setApplied(outcome);
    } catch (e) {
      if (!abort.current.signal.aborted) {
        setError(e instanceof Error ? e.message : 'The draft could not be generated.');
      }
    } finally {
      setStreaming(false);
    }
  };

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="justify-self-start"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Sparkles aria-hidden="true" />
        Draft with AI
      </Button>
    );
  }

  const title = partialTitle(live);
  return (
    <section
      aria-label="Draft with AI"
      className="grid gap-2 rounded-lg border border-dashed bg-muted/30 p-3"
    >
      <Label htmlFor="ai-draft-text">Describe it in your own words</Label>
      <Textarea
        id="ai-draft-text"
        rows={3}
        value={text}
        maxLength={8000}
        placeholder="e.g. Customers get charged twice when the Stripe webhook is retried"
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {streaming ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              abort.current?.abort();
            }}
          >
            <Square aria-hidden="true" />
            Stop
          </Button>
        ) : (
          <Button type="button" size="sm" onClick={() => void generate()}>
            <Sparkles aria-hidden="true" />
            {applied ? 'Draft again' : 'Generate draft'}
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          AI suggestions fill the form below. Nothing is created until you press Create.
        </span>
      </div>
      <div aria-live="polite" className="text-sm">
        {streaming && (
          <p className="text-muted-foreground">
            Drafting… {title ? <span className="font-medium text-foreground">{title}</span> : null}
          </p>
        )}
        {applied && (
          <p className="text-muted-foreground">
            Draft applied. Suggested priority {PRIORITY_LABELS[applied.draft.priority]}:{' '}
            {applied.draft.priorityRationale} Area: {applied.draft.technicalArea}. Review it before
            creating.
            {applied.droppedLabels.length > 0 &&
              ` Ignored labels this project does not have: ${applied.droppedLabels.join(', ')}.`}
          </p>
        )}
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          {error}
        </Alert>
      )}
    </section>
  );
}
