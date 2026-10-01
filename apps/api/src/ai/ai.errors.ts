import { ServiceUnavailableException } from '@nestjs/common';

/** The AI service is not configured, not reachable, or its model provider is down (NFR-4). */
export class AiUnavailableException extends ServiceUnavailableException {
  constructor(reason = 'The AI assistant is unavailable right now. Everything else still works.') {
    super(reason);
  }
}

/** The AI service answered, but not with something usable (invalid output, 4xx/5xx). */
export class AiFailedError extends Error {
  constructor(
    message: string,
    /** Worth retrying later (provider rate limit or outage) rather than failing for good. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiFailedError';
  }
}
