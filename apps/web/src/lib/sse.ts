export interface SseEvent {
  event: string;
  data: string;
}

/**
 * Reads a text/event-stream response body. EventSource cannot send a POST body or an
 * Authorization header, so streamed endpoints are read with fetch and parsed here.
 */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true keeps a multi-byte character split across chunks intact.
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let end = buffer.indexOf('\n\n');
      while (end !== -1) {
        const event = parse(buffer.slice(0, end));
        if (event) yield event;
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf('\n\n');
      }
    }
    const last = parse(buffer + decoder.decode());
    if (last) yield last;
  } finally {
    reader.releaseLock();
  }
}

function parse(block: string): SseEvent | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}
