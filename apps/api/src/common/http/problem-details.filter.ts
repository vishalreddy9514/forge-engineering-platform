import { PROBLEM_JSON_CONTENT_TYPE, type ProblemDetails } from '@forge/types';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { STATUS_CODES } from 'node:http';

/**
 * Converts every error into an RFC 9457 problem+json response. Unexpected errors are logged
 * with their stack and returned as a generic 500, so internals never leak to clients.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request & { id?: string }>();
    const res = http.getResponse<Response>();

    const problem = this.toProblem(exception, req);
    if (problem.status >= 500) {
      this.logger.error(
        { err: exception, requestId: problem.requestId },
        'Unhandled error while processing request',
      );
    }

    res.status(problem.status).type(PROBLEM_JSON_CONTENT_TYPE).json(problem);
  }

  private toProblem(exception: unknown, req: Request & { id?: string }): ProblemDetails {
    const base = { instance: req.originalUrl, requestId: req.id };

    if (!(exception instanceof HttpException)) {
      return {
        ...base,
        type: 'about:blank',
        title: 'Internal Server Error',
        status: HttpStatus.INTERNAL_SERVER_ERROR,
      };
    }

    const status = exception.getStatus();
    const body = exception.getResponse();
    const title = STATUS_CODES[status] ?? 'Error';
    const problem: ProblemDetails = { ...base, type: 'about:blank', title, status };

    // Nest's built-in exceptions carry { message: string | string[] }; ours may carry errors[].
    if (typeof body === 'string') {
      problem.detail = body;
    } else if (typeof body === 'object') {
      const { message, errors } = body as { message?: unknown; errors?: ProblemDetails['errors'] };
      if (typeof message === 'string' && message !== title) problem.detail = message;
      if (Array.isArray(message)) problem.detail = message.join('; ');
      if (errors) problem.errors = errors;
    }
    return problem;
  }
}
