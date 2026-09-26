import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import type { Env } from '../config/env';

const RANGE_API = 'https://api.pwnedpasswords.com/range/';
const TIMEOUT_MS = 2_000;

/**
 * Rejects passwords that appear in known breaches (FR-1.1, NIST SP 800-63B §5.1.1.2) using the
 * Have I Been Pwned k-anonymity API: only the first 5 hex characters of the SHA-1 hash leave
 * the server, never the password or its full hash. Fails open: if the API is slow or down,
 * registration still works.
 */
@Injectable()
export class BreachedPasswordService {
  private readonly logger = new Logger(BreachedPasswordService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async isBreached(password: string): Promise<boolean> {
    if (!this.config.get('HIBP_ENABLED', { infer: true })) return false;

    const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
    const prefix = sha1.slice(0, 5);
    const suffix = sha1.slice(5);

    try {
      const res = await fetch(`${RANGE_API}${prefix}`, {
        // Padding makes every response a similar size, hiding the prefix from observers.
        headers: { 'Add-Padding': 'true', 'User-Agent': 'forge-api' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HIBP responded ${res.status}`);
      const body = await res.text();
      return body.split('\n').some((line) => {
        const [hashSuffix, count] = line.trim().split(':');
        return hashSuffix === suffix && Number(count) > 0;
      });
    } catch (error) {
      this.logger.warn({ err: error }, 'Breached-password check unavailable; allowing password');
      return false;
    }
  }
}
