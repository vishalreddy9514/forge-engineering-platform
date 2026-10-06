import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { REDIS_CLIENT } from '../infrastructure/redis/redis.module';
import { createAppJwt } from './app-jwt';
import { GithubApiError, GithubRateLimitError } from './github.errors';
import { GithubSettings } from './github.settings';
import { githubRateLimitRemaining } from '../observability/metrics';

export type Query = Record<string, string | number | undefined>;

export interface RequestOptions {
  /**
   * Background work (sync, reconciliation) stops while the installation's remaining quota is at
   * or below the reserve, leaving it for calls a person is waiting on.
   */
  background?: boolean;
}

interface Budget {
  remaining: number;
  resetAt: number;
}

const InstallationToken = z.object({ token: z.string(), expires_at: z.iso.datetime() });

const REQUEST_TIMEOUT_MS = 15_000;
/** Installation tokens live an hour; refresh well before GitHub expires them. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** Secondary rate limits without a Retry-After: GitHub asks clients to wait at least a minute. */
const SECONDARY_WAIT_MS = 60_000;

/**
 * Minimal GitHub REST client (ADR-0008). Authenticates as the App (JWT) or as an installation
 * (short-lived token cached in Redis), follows pagination, and is rate-limit aware (FR-6.5):
 *
 * - every response's `X-RateLimit-Remaining`/`-Reset` is recorded per installation in Redis,
 *   shared by the API and all workers;
 * - background calls are refused locally, before reaching GitHub, while the recorded remaining
 *   quota is at or below the reserve;
 * - primary (403/429 with remaining 0) and secondary (`Retry-After`) limits become a
 *   {@link GithubRateLimitError} carrying when to resume, which the job processor turns into a
 *   delayed retry instead of a failure.
 */
@Injectable()
export class GithubClient {
  private readonly logger = new Logger(GithubClient.name);

  constructor(
    private readonly settings: GithubSettings,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** A request authenticated as the App itself (installation lookups). */
  async appRequest(path: string, method: 'GET' | 'POST' = 'GET'): Promise<unknown> {
    const app = this.settings.require();
    const response = await this.send(this.url(path), createAppJwt(app.appId, app.privateKey), {
      method,
    });
    return response.json();
  }

  /** One GET authenticated as an installation. */
  async get(
    installationId: number,
    path: string,
    query: Query = {},
    options: RequestOptions = {},
  ): Promise<unknown> {
    const response = await this.installationRequest(installationId, this.url(path, query), options);
    return response.json();
  }

  /**
   * Walks a list endpoint page by page (following `Link: rel="next"`), yielding each page's
   * items. Stops after `maxPages`, or earlier when the caller stops iterating.
   */
  async *paginate(
    installationId: number,
    path: string,
    query: Query,
    options: RequestOptions & { maxPages: number; items?: (body: unknown) => unknown[] },
  ): AsyncGenerator<unknown[]> {
    let url: string | null = this.url(path, { per_page: 100, ...query });
    for (let page = 0; url && page < options.maxPages; page++) {
      const response = await this.installationRequest(installationId, url, options);
      const body: unknown = await response.json();
      yield options.items ? options.items(body) : z.array(z.unknown()).parse(body);
      url = this.nextPage(response.headers.get('link'));
    }
  }

  /** Forgets a cached token, e.g. after GitHub rejected it or the installation was removed. */
  async evictToken(installationId: number): Promise<void> {
    await this.redis.del(tokenKey(installationId));
  }

  private async installationRequest(
    installationId: number,
    url: string,
    options: RequestOptions,
  ): Promise<Response> {
    await this.checkBudget(installationId, options.background ?? false);
    const token = await this.installationToken(installationId);
    try {
      return await this.send(url, token, { installationId });
    } catch (error) {
      // A revoked or expired token: drop it so the retry mints a fresh one.
      if (error instanceof GithubApiError && error.status === 401) {
        await this.evictToken(installationId);
      }
      throw error;
    }
  }

  private async installationToken(installationId: number): Promise<string> {
    const cached = await this.redis.get(tokenKey(installationId));
    if (cached) return cached;

    let response: unknown;
    try {
      response = await this.appRequest(
        `/app/installations/${String(installationId)}/access_tokens`,
        'POST',
      );
    } catch (error) {
      if (error instanceof GithubApiError && error.status === 404) {
        throw new GithubApiError(404, 'The GitHub App is no longer installed on this account');
      }
      throw error;
    }
    const body = InstallationToken.parse(response);
    const ttl = Date.parse(body.expires_at) - Date.now() - TOKEN_REFRESH_MARGIN_MS;
    if (ttl > 0) await this.redis.set(tokenKey(installationId), body.token, 'PX', ttl);
    return body.token;
  }

  private async send(
    url: string,
    token: string,
    options: { method?: 'GET' | 'POST'; installationId?: number },
  ): Promise<Response> {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': 'forge-engineering-platform',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (options.installationId !== undefined) {
      await this.recordBudget(options.installationId, response.headers);
    }
    if (response.ok) return response;

    const message = await response
      .json()
      .then((body: unknown) => z.object({ message: z.string() }).parse(body).message)
      .catch(() => response.statusText);
    if (response.status === 403 || response.status === 429) {
      const resumeAt = rateLimitReset(response.headers, message);
      if (resumeAt) {
        this.logger.warn(`GitHub rate limit hit; resuming after ${resumeAt.toISOString()}`);
        throw new GithubRateLimitError(resumeAt);
      }
    }
    throw new GithubApiError(response.status, `GitHub ${String(response.status)}: ${message}`);
  }

  private async checkBudget(installationId: number, background: boolean): Promise<void> {
    if (!background) return;
    const raw = await this.redis.get(budgetKey(installationId));
    if (!raw) return;
    const budget = JSON.parse(raw) as Budget;
    if (budget.remaining <= this.settings.rateLimitReserve && budget.resetAt > Date.now()) {
      throw new GithubRateLimitError(new Date(budget.resetAt));
    }
  }

  private async recordBudget(installationId: number, headers: Headers): Promise<void> {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (!headers.has('x-ratelimit-remaining') || !Number.isFinite(remaining) || !reset) return;
    const budget: Budget = { remaining, resetAt: reset * 1000 };
    githubRateLimitRemaining.set({ installation: String(installationId) }, remaining);
    const ttl = budget.resetAt - Date.now();
    if (ttl > 0) {
      await this.redis.set(budgetKey(installationId), JSON.stringify(budget), 'PX', ttl);
    }
  }

  private url(path: string, query: Query = {}): string {
    const url = new URL(this.settings.apiUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * The next page from a Link header. Only followed on GitHub's own API origin, so a tampered
   * header can never send the installation token to another host.
   */
  private nextPage(link: string | null): string | null {
    const next = link && /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
    if (!next) return null;
    const url = new URL(next);
    if (url.origin !== new URL(this.settings.apiUrl).origin) {
      this.logger.warn(`Ignoring a pagination link to another origin: ${url.origin}`);
      return null;
    }
    return url.toString();
  }
}

/**
 * When a 403/429 is a rate limit, the time to resume: the secondary limit's Retry-After, the
 * primary limit's reset, or a minute for a secondary limit GitHub reports only in the message.
 * Null for an ordinary permission error.
 */
export function rateLimitReset(headers: Headers, message: string, now = Date.now()): Date | null {
  const retryAfter = Number(headers.get('retry-after'));
  if (headers.has('retry-after') && Number.isFinite(retryAfter)) {
    return new Date(now + retryAfter * 1000);
  }
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'));
    return new Date(Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + SECONDARY_WAIT_MS);
  }
  if (/secondary rate limit/i.test(message)) return new Date(now + SECONDARY_WAIT_MS);
  return null;
}

const tokenKey = (installationId: number) => `github:token:${String(installationId)}`;
const budgetKey = (installationId: number) => `github:rate:${String(installationId)}`;
