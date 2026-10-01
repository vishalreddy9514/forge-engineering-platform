import {
  type Citation,
  ChatStreamEvent,
  Conversation,
  ConversationDetail,
  type CreateDocumentRequest,
  type DocumentSourceType,
  ProjectDocument,
  ProjectDocumentDetail,
  RelatedIssuesResponse,
  SemanticSearchResponse,
} from '@forge/types';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import { apiFetch, apiJson } from '@/lib/api';
import { aiKeys } from '@/lib/queries/ai';
import { readSse } from '@/lib/sse';

export const searchKeys = {
  semantic: (q: string, projectId: string | undefined, types: DocumentSourceType[]) =>
    ['search', 'semantic', q, projectId ?? 'all', types] as const,
  related: (issueId: string) => ['search', 'related', issueId] as const,
  conversations: ['ai', 'conversations'] as const,
  conversation: (id: string) => ['ai', 'conversations', id] as const,
  documents: (projectId: string) => ['documents', projectId] as const,
  document: (projectId: string, id: string) => ['documents', projectId, id] as const,
};

/** While an uploaded document is still being embedded, its card refreshes until it is indexed. */
export const INDEXING_POLL_MS = 2_000;

// ───────────────────────────── Semantic search (FR-11.2) ─────────────────────────────

export function useSemanticSearch(q: string, projectId?: string, types: DocumentSourceType[] = []) {
  const query = q.trim();
  return useQuery({
    queryKey: searchKeys.semantic(query, projectId, types),
    queryFn: () => {
      const params = new URLSearchParams({ q: query });
      if (projectId) params.set('projectId', projectId);
      for (const type of types) params.append('type', type);
      return apiJson(`/search/semantic?${params.toString()}`, SemanticSearchResponse);
    },
    enabled: query.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

// ───────────────────────────── Related issues (FR-7.3) ─────────────────────────────

export function useRelatedIssues(issueId: string, enabled: boolean) {
  return useQuery({
    queryKey: searchKeys.related(issueId),
    queryFn: () => apiJson(`/issues/${issueId}/related`, RelatedIssuesResponse),
    enabled,
    staleTime: 60_000,
  });
}

/** Possible duplicates of text that is being drafted (not an issue yet). */
export function relatedToDraft(projectId: string, text: string, signal?: AbortSignal) {
  return apiJson(`/projects/${projectId}/ai/related`, RelatedIssuesResponse, {
    method: 'POST',
    body: JSON.stringify({ text }),
    signal,
  });
}

// ───────────────────────────── Assistant chat (FR-7.4) ─────────────────────────────

export interface ChatHandlers {
  onConversation?: (conversationId: string) => void;
  onText?: (textSoFar: string) => void;
  onTool?: (description: string) => void;
}

export interface ChatAnswer {
  conversationId: string;
  messageId: string;
  answer: string;
  citations: Citation[];
}

/**
 * Asks the assistant a question and streams the answer. Resolves with the final answer, whose
 * text replaces the streamed one (invalid citation numbers are removed from it). Rejects with
 * the server's message on failure.
 */
export async function streamChat(
  body: { message: string; conversationId?: string; projectId?: string },
  handlers: ChatHandlers = {},
  signal?: AbortSignal,
): Promise<ChatAnswer> {
  const res = await apiFetch('/ai/chat', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.body) throw new Error('The assistant could not answer. Please try again.');
  let soFar = '';
  for await (const raw of readSse(res.body)) {
    const data: unknown = JSON.parse(raw.data);
    const parsed = ChatStreamEvent.safeParse({ event: raw.event, data });
    if (!parsed.success) continue;
    const event = parsed.data;
    switch (event.event) {
      case 'conversation':
        handlers.onConversation?.(event.data.conversationId);
        break;
      case 'delta':
        soFar += event.data.text;
        handlers.onText?.(soFar);
        break;
      case 'tool':
        // A new round of text follows the tool's results.
        soFar = '';
        handlers.onTool?.(event.data.description);
        break;
      case 'result':
        return event.data;
      case 'error':
        throw new Error(event.data.message);
    }
  }
  throw new Error('The answer was interrupted. Please try again.');
}

export function useConversations() {
  return useQuery({
    queryKey: searchKeys.conversations,
    queryFn: () => apiJson('/ai/conversations', z.array(Conversation)),
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: searchKeys.conversation(id ?? ''),
    queryFn: () => apiJson(`/ai/conversations/${id ?? ''}`, ConversationDetail),
    enabled: id !== null,
  });
}

export function useDeleteConversation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch(`/ai/conversations/${id}`, { method: 'DELETE' }),
    onSettled: () => client.invalidateQueries({ queryKey: searchKeys.conversations }),
  });
}

/** After an answer: the conversation list order and the AI allowance have changed. */
export function useRefreshAfterAnswer() {
  const client = useQueryClient();
  return async (conversationId: string) => {
    await Promise.all([
      client.invalidateQueries({ queryKey: searchKeys.conversations }),
      client.invalidateQueries({ queryKey: searchKeys.conversation(conversationId) }),
      client.invalidateQueries({ queryKey: aiKeys.status }),
    ]);
  };
}

// ───────────────────────────── Uploaded documents (FR-8.1) ─────────────────────────────

export function useDocuments(projectId: string) {
  return useQuery({
    queryKey: searchKeys.documents(projectId),
    queryFn: () => apiJson(`/projects/${projectId}/documents`, z.array(ProjectDocument)),
    refetchInterval: (query) =>
      query.state.data?.some((d) => d.indexedAt === null) ? INDEXING_POLL_MS : false,
  });
}

export function useDocument(projectId: string, id: string) {
  return useQuery({
    queryKey: searchKeys.document(projectId, id),
    queryFn: () => apiJson(`/projects/${projectId}/documents/${id}`, ProjectDocumentDetail),
  });
}

export function useCreateDocument(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateDocumentRequest) =>
      apiJson(`/projects/${projectId}/documents`, ProjectDocument, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSettled: () => client.invalidateQueries({ queryKey: searchKeys.documents(projectId) }),
  });
}

export function useDeleteDocument(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/projects/${projectId}/documents/${id}`, { method: 'DELETE' }),
    onSettled: () => client.invalidateQueries({ queryKey: searchKeys.documents(projectId) }),
  });
}
