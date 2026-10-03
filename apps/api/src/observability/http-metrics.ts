import type { NextFunction, Request, Response } from 'express';

import { resolveRequestId } from '../common/http/request-id';
import { httpRequestDuration, routeLabel } from './metrics';
import { runWithRequestId } from './request-context';

/**
 * First middleware of every request: settles its ID (reused by the request logger), runs the
 * rest of the request under it, and records its duration by route template once the response
 * closes (finished, or abandoned by the client, as streams often are).
 */
export function requestObservability(req: Request, res: Response, next: NextFunction): void {
  const requestId = resolveRequestId(req, res);
  (req as Request & { id?: string }).id = requestId;
  const end = httpRequestDuration.startTimer();
  res.once('close', () => {
    end({ method: req.method, route: routeLabel(req), status: String(res.statusCode) });
  });
  runWithRequestId(requestId, next);
}
