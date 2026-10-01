import { readSse, type SseEvent, sseFrame } from './sse';

async function parse(chunks: (string | Uint8Array)[]): Promise<SseEvent[]> {
  const encoder = new TextEncoder();
  const body = () =>
    (function* () {
      for (const chunk of chunks) yield typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    })();
  const events: SseEvent[] = [];
  for await (const event of readSse(toAsync(body()))) events.push(event);
  return events;
}

describe('readSse', () => {
  it('reads events split across arbitrary chunk boundaries', async () => {
    const stream = sseFrame('delta', { text: 'a' }) + sseFrame('result', { ok: true });
    const chunks = stream.match(/.{1,5}/gs) ?? [];
    expect(await parse(chunks)).toEqual([
      { event: 'delta', data: '{"text":"a"}' },
      { event: 'result', data: '{"ok":true}' },
    ]);
  });

  it('keeps a multi-byte character that is split between chunks intact', async () => {
    const bytes = new TextEncoder().encode(sseFrame('delta', { text: 'café ✓' }));
    const cut = bytes.indexOf(0xe2); // first byte of ✓
    expect(await parse([bytes.slice(0, cut + 1), bytes.slice(cut + 1)])).toEqual([
      { event: 'delta', data: '{"text":"café ✓"}' },
    ]);
  });

  it('accepts CRLF line endings, multi-line data and a final event without a blank line', async () => {
    expect(await parse(['event: a\r\ndata: 1\r\ndata: 2\r\n\r\n', 'data: tail'])).toEqual([
      { event: 'a', data: '1\n2' },
      { event: 'message', data: 'tail' },
    ]);
  });

  it('ignores comments and blocks without data', async () => {
    expect(await parse([': keep-alive\n\nevent: x\n\n'])).toEqual([]);
  });
});

async function* toAsync<T>(items: Iterable<T>): AsyncGenerator<T> {
  for (const item of items) yield await Promise.resolve(item);
}
