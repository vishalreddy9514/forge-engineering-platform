export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Parses a text/event-stream body into events (the subset of the SSE format the AI service
 * writes: `event:` and `data:` lines, blank-line separated). Chunk boundaries can fall anywhere,
 * including inside a multi-byte character, so bytes are decoded as a stream.
 */
export async function* readSse(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const parsed = parseBlock(buffer.slice(0, end));
      if (parsed) yield parsed;
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf('\n\n');
    }
  }
  buffer += decoder.decode();
  const last = parseBlock(buffer);
  if (last) yield last;
}

function parseBlock(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

/** One SSE frame. JSON-encoded data never contains a raw newline, so it is a single line. */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
