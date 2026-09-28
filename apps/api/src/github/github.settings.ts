import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrivateKey, type KeyObject } from 'node:crypto';

import type { Env } from '../config/env';

export interface GithubApp {
  appId: number;
  slug: string;
  privateKey: KeyObject;
  webhookSecret: string;
}

/**
 * GitHub App configuration. The integration is optional: without an App configured, its
 * endpoints answer 503 and everything else in Forge works. The private key is parsed at startup
 * so a malformed key stops the process instead of failing at the first sync.
 */
@Injectable()
export class GithubSettings {
  readonly app: GithubApp | null;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly rateLimitReserve: number;
  readonly maxPages: number;

  constructor(config: ConfigService<Env, true>) {
    const appId = config.get('GITHUB_APP_ID', { infer: true });
    const slug = config.get('GITHUB_APP_SLUG', { infer: true });
    const pem = config.get('GITHUB_APP_PRIVATE_KEY', { infer: true });
    const webhookSecret = config.get('GITHUB_WEBHOOK_SECRET', { infer: true });
    // Env validation guarantees all four or none.
    this.app =
      appId && slug && pem && webhookSecret
        ? {
            appId,
            slug,
            privateKey: createPrivateKey(pem.replace(/\\n/g, '\n')),
            webhookSecret,
          }
        : null;
    this.apiUrl = config.get('GITHUB_API_URL', { infer: true }).replace(/\/+$/, '');
    this.webUrl = config.get('GITHUB_WEB_URL', { infer: true }).replace(/\/+$/, '');
    this.rateLimitReserve = config.get('GITHUB_RATE_LIMIT_RESERVE', { infer: true });
    this.maxPages = config.get('GITHUB_SYNC_MAX_PAGES', { infer: true });
  }

  require(): GithubApp {
    if (!this.app)
      throw new ServiceUnavailableException('The GitHub integration is not configured');
    return this.app;
  }

  /** Where an administrator installs the App on a GitHub account or organisation. */
  installUrl(): string | null {
    return this.app ? `${this.webUrl}/apps/${this.app.slug}/installations/new` : null;
  }
}
