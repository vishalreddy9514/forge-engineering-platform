import { HttpException, HttpStatus } from '@nestjs/common';

/** 429 that tells the client when to retry; the problem-details filter emits `Retry-After`. */
export class TooManyRequestsException extends HttpException {
  constructor(
    readonly retryAfterSeconds: number,
    message = `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}
