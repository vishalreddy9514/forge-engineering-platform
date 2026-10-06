import {
  type ArgumentsHost,
  BadRequestException,
  HttpException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import * as errors from '../../observability/errors';
import { ProblemDetailsFilter } from './problem-details.filter';

function run(exception: unknown) {
  const res = { status: jest.fn(), type: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.type.mockReturnValue(res);
  const req = {
    originalUrl: '/api/v1/things/1',
    id: 'req-1',
    route: { path: '/api/v1/things/:id' },
  };
  const host = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;

  new ProblemDetailsFilter().catch(exception, host);
  return { res, body: res.json.mock.calls[0]?.[0] as Record<string, unknown> };
}

describe('ProblemDetailsFilter', () => {
  let logError: jest.SpyInstance;

  beforeEach(() => {
    logError = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    logError.mockRestore();
  });

  it('maps an HttpException to problem+json with the request context', () => {
    const { res, body } = run(new NotFoundException('Project not found'));
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.type).toHaveBeenCalledWith('application/problem+json');
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: 'Project not found',
      instance: '/api/v1/things/1',
      requestId: 'req-1',
    });
  });

  it('omits detail when it only repeats the title', () => {
    const { body } = run(new NotFoundException());
    expect(body).not.toHaveProperty('detail');
  });

  it('joins validation message arrays', () => {
    const { body } = run(new BadRequestException(['name is required', 'key is too long']));
    expect(body.detail).toBe('name is required; key is too long');
  });

  it('passes through structured field errors', () => {
    const errors = [{ path: 'title', message: 'Required' }];
    const { body } = run(new HttpException({ message: 'Validation failed', errors }, 422));
    expect(body).toMatchObject({ status: 422, title: 'Unprocessable Entity', errors });
  });

  it('does not log client errors', () => {
    run(new NotFoundException());
    expect(logError).not.toHaveBeenCalled();
  });

  it('logs unexpected errors with the request ID but hides their details from the client', () => {
    const error = new Error('connection string postgres://secret@db');
    const { res, body } = run(error);

    expect(logError).toHaveBeenCalledWith(
      { err: error, requestId: 'req-1' },
      'Unhandled error while processing request',
    );
    expect(res.status).toHaveBeenCalledWith(500);
    expect(body).toEqual({
      type: 'about:blank',
      title: 'Internal Server Error',
      status: 500,
      instance: '/api/v1/things/1',
      requestId: 'req-1',
    });
  });

  describe('error reporting', () => {
    let report: jest.SpyInstance;

    beforeEach(() => {
      report = jest.spyOn(errors, 'reportError').mockImplementation(() => undefined);
    });

    afterEach(() => {
      report.mockRestore();
    });

    it('reports unexpected errors with their route template', () => {
      const bug = new TypeError("Cannot read properties of undefined (reading 'id')");
      run(bug);
      expect(report).toHaveBeenCalledWith(bug, { route: '/api/v1/things/:id' });
    });

    it('does not report the errors the API means to return (a degraded AI is a 503)', () => {
      run(new NotFoundException());
      run(new ServiceUnavailableException('The AI assistant is unavailable'));
      expect(report).not.toHaveBeenCalled();
    });
  });
});
