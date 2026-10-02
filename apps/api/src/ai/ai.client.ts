import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';

import type { Env } from '../config/env';
import { AiFailedError, AiUnavailableException } from './ai.errors';
import {
  IndexResponse,
  RelatedResponse,
  type ReviewInput,
  ReviewResponse,
  SearchResponse,
  SummaryResponse,
} from './ai.wire';

const PING_TTL_MS = 30_000;
const PING_TIMEOUT_MS = 2_000;
const REVIEW_TIMEOUT_FACTOR = 5;

export interface SummaryInput {
  issue: {
    key: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    type: string;
  };
  comments: { author: string; createdAt: string; body: string }[];
}

/** One chat request to the AI service (apps/ai-service/app/features/chat.py). */
export interface ChatTurnInput {
  messages: { role: 'user' | 'assistant'; content: string }[];
  projects: { id: string; key: string; name: string }[];
  toolCall?: { id: string; name: string; arguments: string };
  toolResult?: { total: number; issues: ToolIssue[] };
}

export interface ToolIssue {
  id: string;
  projectId: string;
  key: string;
  title: string;
  type: string;
  status: string;
  priority: string;
  assignee: string | null;
  updatedAt: string;
  url: string;
}

/**
 * HTTP client for the internal AI service (architecture §7). Authenticated with the shared
 * service token. The AI service is optional (NFR-4): when it is not configured or does not
 * answer, calls fail fast with {@link AiUnavailableException} and nothing else is affected.
 */
@Injectable()
export class AiClient {
  private readonly logger = new Logger(AiClient.name);
  private readonly baseUrl: string | undefined;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private lastPing: { at: number; ok: boolean } | undefined;

  constructor(config: ConfigService<Env, true>) {
    this.baseUrl = config.get('AI_SERVICE_URL', { infer: true })?.replace(/\/+$/, '');
    this.token = config.get('AI_SERVICE_TOKEN', { infer: true });
    this.timeoutMs = config.get('AI_REQUEST_TIMEOUT_MS', { infer: true });
  }

  get configured(): boolean {
    return Boolean(this.baseUrl && this.token);
  }

  /**
   * Reachability check. Cached for the web app's "is AI available" polling; `fresh` pings now,
   * for an explicit action about to be queued (a local health check, well under a second).
   */
  async isAvailable({ fresh = false }: { fresh?: boolean } = {}): Promise<boolean> {
    if (!this.configured) return false;
    if (!fresh && this.lastPing && Date.now() - this.lastPing.at < PING_TTL_MS) {
      return this.lastPing.ok;
    }
    let ok = false;
    try {
      const res = await fetch(`${this.baseUrl ?? ''}/health/ready`, {
        signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    this.lastPing = { at: Date.now(), ok };
    return ok;
  }

  /** Starts a streamed draft; the caller reads the SSE body. */
  async draftStream(
    body: { text: string; projectKey: string; projectName: string; labels: string[] },
    signal: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const res = await this.post('/v1/drafts', body, signal);
    if (!res.body) throw new AiFailedError('The AI service sent no response body', true);
    return res.body;
  }

  async summarize(body: SummaryInput): Promise<SummaryResponse> {
    const res = await this.post('/v1/summaries', body, AbortSignal.timeout(this.timeoutMs));
    const parsed = SummaryResponse.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new AiFailedError('The AI service returned a summary Forge could not read', false);
    }
    return parsed.data;
  }

  /**
   * Reviews a pull request (FR-9.2). One model call per file plus a summary, so it gets a
   * longer timeout than other calls; it only ever runs in a background job.
   */
  async review(body: ReviewInput): Promise<ReviewResponse> {
    const res = await this.post(
      '/v1/reviews',
      body,
      AbortSignal.timeout(this.timeoutMs * REVIEW_TIMEOUT_FACTOR),
    );
    return this.read(res, ReviewResponse, 'review');
  }

  /** Chunks and embeds a document the API has written (FR-8.2). Idempotent. */
  async index(documentId: string): Promise<IndexResponse> {
    const res = await this.post('/v1/index', { documentId }, AbortSignal.timeout(this.timeoutMs));
    return this.read(res, IndexResponse, 'index result');
  }

  async search(
    body: { query: string; projectIds: string[]; sourceTypes?: string[]; limit: number },
    signal: AbortSignal,
  ): Promise<SearchResponse> {
    return this.read(await this.post('/v1/search', body, signal), SearchResponse, 'search');
  }

  async related(
    body: { projectId: string; issueId?: string; text?: string; limit: number },
    signal: AbortSignal,
  ): Promise<RelatedResponse> {
    return this.read(await this.post('/v1/related', body, signal), RelatedResponse, 'related');
  }

  /** Starts a streamed chat turn; the caller reads the SSE body. */
  async chatStream(body: ChatTurnInput, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const res = await this.post('/v1/chat', body, signal);
    if (!res.body) throw new AiFailedError('The AI service sent no response body', true);
    return res.body;
  }

  private async read<T>(res: Response, schema: z.ZodType<T>, what: string): Promise<T> {
    const parsed = schema.safeParse(await res.json().catch(() => null));
    if (!parsed.success) {
      throw new AiFailedError(`The AI service returned a ${what} Forge could not read`, false);
    }
    return parsed.data;
  }

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    if (!this.configured) throw new AiUnavailableException();
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl ?? ''}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal.aborted && (signal.reason as Error | undefined)?.name !== 'TimeoutError') {
        throw error; // the caller cancelled
      }
      this.logger.warn(`AI service unreachable: ${String(error)}`);
      this.lastPing = { at: Date.now(), ok: false };
      throw new AiUnavailableException();
    }
    if (res.ok) return res;

    const detail = await res
      .json()
      .then((json: unknown) => z.object({ detail: z.unknown() }).parse(json).detail)
      .catch(() => res.statusText);
    const message = `AI service ${String(res.status)}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    // The AI service answers 503 when its provider is rate limited or down (worth retrying) and
    // 502 when the output was unusable or the provider refused (retrying will not help).
    throw new AiFailedError(message, res.status === 503 || res.status === 504);
  }
}
