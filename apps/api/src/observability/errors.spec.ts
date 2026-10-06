import * as Sentry from '@sentry/node';
import { createServer, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';

import { initErrorReporting, reportError, scrubEvent } from './errors';
import { runWithRequestId } from './request-context';

describe('scrubEvent', () => {
  it('keeps the error and drops credentials, bodies, query strings and the user', () => {
    const event = scrubEvent({
      type: undefined,
      exception: { values: [{ type: 'Error', value: 'boom' }] },
      user: { id: 'u1', email: 'sam@example.com', ip_address: '203.0.113.9' },
      request: {
        url: 'https://forge.example.com/reset-password?token=secret',
        query_string: 'token=secret',
        cookies: { forge_refresh: 'secret' },
        data: '{"password":"hunter2"}',
        headers: {
          Authorization: 'Bearer secret',
          cookie: 'forge_refresh=secret',
          'X-Forwarded-For': '203.0.113.9',
          referer: 'https://forge.example.com/reset-password?token=secret',
          'user-agent': 'Mozilla/5.0',
        },
      },
      breadcrumbs: [{ category: 'http', data: { url: 'https://api.github.com/x?access_token=s' } }],
    });

    expect(event.exception?.values?.[0]?.value).toBe('boom');
    expect(event.user).toBeUndefined();
    expect(event.request).toEqual({
      url: 'https://forge.example.com/reset-password',
      headers: { 'user-agent': 'Mozilla/5.0' },
    });
    expect(event.breadcrumbs?.[0]?.data?.url).toBe('https://api.github.com/x');
  });
});

describe('error reporting against a Sentry endpoint', () => {
  let server: Server;
  const envelopes: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        envelopes.push(
          (req.headers['content-encoding'] === 'gzip' ? gunzipSync(body) : body).toString(),
        );
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await Sentry.close(1_000);
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it('is off without a DSN and a no-op to report into', () => {
    expect(initErrorReporting('api', {})).toBe(false);
    expect(() => {
      reportError(new Error('ignored'));
    }).not.toThrow();
  });

  it('sends the error with its request ID, service and tags', async () => {
    const { port } = server.address() as { port: number };
    expect(
      initErrorReporting('worker', { SENTRY_DSN: `http://public@127.0.0.1:${String(port)}/1` }),
    ).toBe(true);

    runWithRequestId('req-err-1', () => {
      reportError(new Error('summary job exploded'), { queue: 'ai', job: 'issue-summary' });
    });
    await Sentry.flush(2_000);

    const sent = envelopes.join('\n');
    expect(sent).toContain('summary job exploded');
    expect(sent).toMatch(/"request_id":"req-err-1"/);
    expect(sent).toMatch(/"service":"worker"/);
    expect(sent).toMatch(/"queue":"ai"/);
  });
});
