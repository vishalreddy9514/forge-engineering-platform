import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

const CONTRACT = join(__dirname, '../../../../ai-service/tests/contract');
const load = (name: string) =>
  JSON.parse(readFileSync(join(CONTRACT, `${name}.json`), 'utf8')) as Record<string, unknown>;

export type Mode = 'ok' | 'invalid_output' | 'provider_unavailable' | 'error_503' | 'error_502';

/**
 * Stands in for apps/ai-service. Its answers are the contract files the real service's tests
 * write from real responses, so this cannot drift from what the service actually sends.
 */
export class FakeAiService {
  readonly requests: { path: string; auth: string | undefined; body: Record<string, unknown> }[] =
    [];
  mode: Mode = 'ok';
  private server: Server | undefined;

  constructor(private readonly token: string) {}

  async listen(url: string): Promise<void> {
    const { port, hostname } = new URL(url);
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server?.listen(Number(port), hostname, resolve));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.closeAllConnections();
      this.server.close(() => {
        resolve();
      });
    });
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>)
      : {};
    this.requests.push({ path: req.url ?? '', auth: req.headers.authorization, body });

    if (req.url === '/health/ready') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"status":"ok"}');
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.token}`) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/v1/drafts') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const result = load('draft_result');
      const text = JSON.stringify(result.draft);
      for (let i = 0; i < text.length; i += 40) {
        res.write(`event: delta\ndata: ${JSON.stringify({ text: text.slice(i, i + 40) })}\n\n`);
      }
      const usage = { inputTokens: 400, outputTokens: 150, costUsd: '0.000400' };
      if (this.mode === 'ok') {
        res.write(`event: result\ndata: ${JSON.stringify({ ...result, usage })}\n\n`);
      } else {
        const code = this.mode === 'invalid_output' ? 'invalid_output' : 'provider_unavailable';
        const error = {
          code,
          message: 'OpenAI error 429: internal detail',
          model: 'gpt-4.1-mini',
          usage,
        };
        res.write(`event: error\ndata: ${JSON.stringify(error)}\n\n`);
      }
      res.end();
      return;
    }
    if (req.url === '/v1/summaries') {
      if (this.mode === 'error_503' || this.mode === 'error_502') {
        res
          .writeHead(this.mode === 'error_503' ? 503 : 502, { 'content-type': 'application/json' })
          .end('{"detail":"provider trouble"}');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify({
            ...load('summary_response'),
            usage: { inputTokens: 900, outputTokens: 120, costUsd: '0.000552' },
          }),
        );
      return;
    }
    res.writeHead(404).end();
  }
}
