'use client';

import type { Citation } from '@forge/types';
import { Alert } from '@forge/ui/components/alert';
import { Button } from '@forge/ui/components/button';
import { Label } from '@forge/ui/components/label';
import { Select } from '@forge/ui/components/select';
import { Skeleton } from '@forge/ui/components/skeleton';
import { Textarea } from '@forge/ui/components/textarea';
import { cn } from '@forge/ui/lib/utils';
import { Bot, Plus, Search, Send, Trash2 } from 'lucide-react';
import { type SyntheticEvent, useRef, useState } from 'react';

import { useAiStatus } from '@/lib/queries/ai';
import { useProjects } from '@/lib/queries/projects';
import {
  streamChat,
  useConversation,
  useConversations,
  useDeleteConversation,
  useRefreshAfterAnswer,
} from '@/lib/queries/search';

import { CitedAnswer } from './cited-answer';

interface PendingTurn {
  question: string;
  text: string;
  tool: string | null;
  error: string | null;
}

function Bubble({ role, children }: { role: 'user' | 'assistant'; children: React.ReactNode }) {
  return (
    <li
      className={cn(
        'max-w-[85%] rounded-xl px-4 py-3',
        role === 'user' ? 'justify-self-end bg-foreground text-background' : 'border bg-card',
      )}
      aria-label={role === 'user' ? 'You' : 'Assistant'}
    >
      {children}
    </li>
  );
}

function Answer({ content, citations }: { content: string; citations: Citation[] }) {
  return <CitedAnswer answer={content} citations={citations} />;
}

/**
 * FR-7.4: questions about project work, answered from the project's own issues, comments, pull
 * requests, commits and documents, with every claim linked to its source. Conversations are kept
 * per user; each is limited to one project or to every project the user can read.
 */
export function Assistant() {
  const { data: status } = useAiStatus();
  const { data: conversations, isPending: listPending } = useConversations();
  const { data: projects } = useProjects({ archived: false });
  const [selected, setSelected] = useState<string | null>(null);
  const { data: conversation } = useConversation(selected);
  const remove = useDeleteConversation();
  const refresh = useRefreshAfterAnswer();
  const [scope, setScope] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<PendingTurn | null>(null);
  const abort = useRef<AbortController | null>(null);

  const available = status?.available ?? false;
  const busy = pending !== null && pending.error === null;

  const ask = async (event: SyntheticEvent) => {
    event.preventDefault();
    const question = message.trim();
    if (!question || busy) return;
    setMessage('');
    setPending({ question, text: '', tool: null, error: null });
    abort.current = new AbortController();
    try {
      const answer = await streamChat(
        {
          message: question,
          ...(selected ? { conversationId: selected } : scope ? { projectId: scope } : {}),
        },
        {
          onText: (text) => {
            setPending((turn) => (turn ? { ...turn, text } : turn));
          },
          onTool: (description) => {
            setPending((turn) => (turn ? { ...turn, tool: description, text: '' } : turn));
          },
        },
        abort.current.signal,
      );
      await refresh(answer.conversationId);
      setSelected(answer.conversationId);
      setPending(null);
    } catch (error) {
      const text = error instanceof Error ? error.message : 'The assistant could not answer.';
      setPending((turn) => (turn ? { ...turn, error: text } : turn));
      await refresh(selected ?? '');
    }
  };

  const startNew = () => {
    abort.current?.abort();
    setSelected(null);
    setPending(null);
  };

  if (status && !available) {
    return (
      <Alert>The assistant is unavailable right now. Everything else in Forge still works.</Alert>
    );
  }

  const messages = selected ? (conversation?.messages ?? []) : [];
  const scopeName = conversation?.projectId
    ? projects?.data.find((p) => p.id === conversation.projectId)?.key
    : null;

  return (
    <div className="grid gap-6 md:grid-cols-[14rem_1fr]">
      <aside aria-label="Conversations" className="flex min-w-0 flex-col gap-2">
        <Button variant="outline" size="sm" onClick={startNew}>
          <Plus aria-hidden="true" />
          New conversation
        </Button>
        {listPending ? (
          <Skeleton className="h-24" />
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {conversations?.map((c) => (
              <li key={c.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setSelected(c.id);
                    setPending(null);
                  }}
                  aria-current={c.id === selected ? 'true' : undefined}
                  className={cn(
                    'min-w-0 flex-1 truncate rounded px-2 py-1 text-left hover:bg-muted',
                    c.id === selected && 'bg-muted font-medium',
                  )}
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  aria-label={`Delete conversation ${c.title}`}
                  className="rounded p-1 text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-destructive focus:opacity-100"
                  onClick={() => {
                    if (c.id === selected) startNew();
                    remove.mutate(c.id);
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section aria-label="Chat" className="grid min-w-0 content-start gap-4">
        {messages.length === 0 && !pending && (
          <div className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <Bot className="size-4" aria-hidden="true" />
              Ask about your projects
            </p>
            <p className="mt-2">
              “Why were customers charged twice?” · “Which bugs were fixed last sprint?” · “How do I
              rerun reconciliation?” Answers cite the issues, comments, pull requests and documents
              they come from, and say so when the data doesn&apos;t answer the question.
            </p>
          </div>
        )}

        <ol className="grid gap-3" aria-live="polite">
          {messages.map((m) =>
            m.role === 'TOOL' ? (
              <li
                key={m.id}
                className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground"
              >
                <Search className="size-3.5" aria-hidden="true" />
                {m.content}
              </li>
            ) : (
              <Bubble key={m.id} role={m.role === 'USER' ? 'user' : 'assistant'}>
                {m.role === 'USER' ? (
                  <p className="text-sm whitespace-pre-wrap">{m.content}</p>
                ) : (
                  <Answer content={m.content} citations={m.citations} />
                )}
              </Bubble>
            ),
          )}
          {pending && (
            <>
              <Bubble role="user">
                <p className="text-sm whitespace-pre-wrap">{pending.question}</p>
              </Bubble>
              <Bubble role="assistant">
                {pending.tool && (
                  <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Search className="size-3.5" aria-hidden="true" />
                    {pending.tool}
                  </p>
                )}
                {pending.error ? (
                  <p role="alert" className="text-sm text-destructive">
                    {pending.error}
                  </p>
                ) : pending.text ? (
                  <p className="text-sm whitespace-pre-wrap">{pending.text}</p>
                ) : (
                  <p role="status" className="text-sm text-muted-foreground">
                    Searching project data…
                  </p>
                )}
              </Bubble>
            </>
          )}
        </ol>

        <form onSubmit={(event) => void ask(event)} className="grid gap-2">
          <Label htmlFor="assistant-message" className="sr-only">
            Your question
          </Label>
          <Textarea
            id="assistant-message"
            rows={3}
            value={message}
            maxLength={4000}
            placeholder="Ask a question about your projects"
            onChange={(event) => {
              setMessage(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className="flex items-center justify-between gap-3">
            {selected ? (
              <p className="text-xs text-muted-foreground">
                Searching {scopeName ? `project ${scopeName}` : 'all your projects'}
              </p>
            ) : (
              <Select
                aria-label="Search in"
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value);
                }}
                className="w-56"
              >
                <option value="">All my projects</option>
                {projects?.data.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.key} · {p.name}
                  </option>
                ))}
              </Select>
            )}
            <Button type="submit" disabled={busy || message.trim() === ''}>
              <Send aria-hidden="true" />
              Ask
            </Button>
          </div>
        </form>
      </section>
    </div>
  );
}
