import { z } from 'zod';

import { IssueStatus, IssueType } from './enums';

/**
 * Retrieval contracts (FR-8): semantic search, related issues, assistant chat with citations,
 * and uploaded engineering documents.
 */

export const DocumentSourceType = z.enum(['ISSUE', 'COMMENT', 'PULL_REQUEST', 'COMMIT', 'UPLOAD']);
export type DocumentSourceType = z.infer<typeof DocumentSourceType>;

export const SOURCE_TYPE_LABELS: Record<DocumentSourceType, string> = {
  ISSUE: 'Issue',
  COMMENT: 'Comment',
  PULL_REQUEST: 'Pull request',
  COMMIT: 'Commit',
  UPLOAD: 'Document',
};

// ───────────────────────────── Semantic search (FR-11.2) ─────────────────────────────

export const SemanticSearchQuery = z.object({
  q: z.string().trim().min(2, 'Type at least two characters').max(500),
  /** Limit to one project; omitted = every project the caller can read. */
  projectId: z.uuid().optional(),
  type: z
    .union([DocumentSourceType, z.array(DocumentSourceType)])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SemanticSearchQuery = z.infer<typeof SemanticSearchQuery>;

export const SemanticSearchResult = z.object({
  documentId: z.uuid(),
  projectId: z.uuid(),
  projectKey: z.string(),
  sourceType: DocumentSourceType,
  title: z.string(),
  /** Where the result links to: a Forge page or a GitHub URL. */
  url: z.string(),
  headingPath: z.string().nullable(),
  snippet: z.string(),
  score: z.number(),
});
export type SemanticSearchResult = z.infer<typeof SemanticSearchResult>;

export const SemanticSearchResponse = z.object({ data: z.array(SemanticSearchResult) });
export type SemanticSearchResponse = z.infer<typeof SemanticSearchResponse>;

// ───────────────────────────── Related issues (FR-7.3) ─────────────────────────────

export const RelatedIssue = z.object({
  id: z.uuid(),
  key: z.string(),
  title: z.string(),
  status: IssueStatus,
  type: IssueType,
  /** Cosine similarity, 0–1. Only results above the model's threshold are returned. */
  score: z.number(),
});
export type RelatedIssue = z.infer<typeof RelatedIssue>;

export const RelatedIssuesResponse = z.object({ data: z.array(RelatedIssue) });
export type RelatedIssuesResponse = z.infer<typeof RelatedIssuesResponse>;

/** While drafting there is no issue yet: related issues are found from the text. */
export const RelatedDraftRequest = z.object({
  text: z.string().trim().min(10).max(8000),
});
export type RelatedDraftRequest = z.infer<typeof RelatedDraftRequest>;

// ───────────────────────────── Assistant chat (FR-7.4) ─────────────────────────────

export const Citation = z.object({
  n: z.number().int().min(1),
  sourceType: DocumentSourceType,
  title: z.string(),
  url: z.string(),
  projectKey: z.string().nullable(),
  headingPath: z.string().nullable(),
});
export type Citation = z.infer<typeof Citation>;

export const ChatRequest = z.object({
  /** Continue a conversation; omitted = start a new one. */
  conversationId: z.uuid().optional(),
  /** Scope the question to one project; omitted = every project the caller can read. */
  projectId: z.uuid().optional(),
  message: z.string().trim().min(1, 'Ask a question').max(4000, 'Keep it under 4,000 characters'),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

/** Server-sent events of POST /ai/chat. */
export const ChatStreamEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('conversation'), data: z.object({ conversationId: z.uuid() }) }),
  z.object({ event: z.literal('delta'), data: z.object({ text: z.string() }) }),
  /** The assistant is querying issues (a structured question, not a similarity search). */
  z.object({
    event: z.literal('tool'),
    data: z.object({ name: z.literal('query_issues'), description: z.string() }),
  }),
  z.object({
    event: z.literal('result'),
    data: z.object({
      conversationId: z.uuid(),
      messageId: z.uuid(),
      answer: z.string(),
      citations: z.array(Citation),
    }),
  }),
  z.object({
    event: z.literal('error'),
    data: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEvent>;

export const ChatMessage = z.object({
  id: z.uuid(),
  /** TOOL: a step the assistant took (an issue query), shown with the answer it led to. */
  role: z.enum(['USER', 'ASSISTANT', 'TOOL']),
  content: z.string(),
  citations: z.array(Citation),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const Conversation = z.object({
  id: z.uuid(),
  title: z.string(),
  projectId: z.uuid().nullable(),
  updatedAt: z.string(),
});
export type Conversation = z.infer<typeof Conversation>;

export const ConversationDetail = Conversation.extend({ messages: z.array(ChatMessage) });
export type ConversationDetail = z.infer<typeof ConversationDetail>;

// ───────────────────────────── Uploaded documents (FR-8.1) ─────────────────────────────

/** Markdown or plain text, read in the browser and sent as text. */
export const MAX_DOCUMENT_BYTES = 1024 * 1024;

/** UTF-8 size of a string, without platform APIs (this package runs in the browser and Node). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const CreateDocumentRequest = z.object({
  title: z.string().trim().min(1, 'Give the document a title').max(200),
  content: z
    .string()
    .min(1, 'The document is empty')
    .refine((text) => utf8Length(text) <= MAX_DOCUMENT_BYTES, 'Documents can be up to 1 MB'),
});
export type CreateDocumentRequest = z.infer<typeof CreateDocumentRequest>;

export const ProjectDocument = z.object({
  id: z.uuid(),
  title: z.string(),
  sizeBytes: z.number().int(),
  createdBy: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  createdAt: z.string(),
  /** Null until the document has been chunked and embedded (a few seconds after upload). */
  indexedAt: z.string().nullable(),
  chunkCount: z.number().int(),
});
export type ProjectDocument = z.infer<typeof ProjectDocument>;

export const ProjectDocumentDetail = ProjectDocument.extend({ content: z.string() });
export type ProjectDocumentDetail = z.infer<typeof ProjectDocumentDetail>;
