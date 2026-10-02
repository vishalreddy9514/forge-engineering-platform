/** @jest-environment node */
// Node, not jsdom: the stream is read with ReadableStream and TextDecoder, as in a browser.
import { streamChat } from './search';

const apiFetch = jest.fn();
jest.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args) as unknown,
  apiJson: jest.fn(),
}));

function sse(frames: [string, unknown][], splitAt = 7): Response {
  const text = frames
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  const bytes = new TextEncoder().encode(text);
  // Deliberately awkward chunk boundaries: inside lines and inside frames.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += splitAt)
        controller.enqueue(bytes.slice(i, i + splitAt));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

const result = {
  conversationId: '01900000-0000-7000-8000-000000000001',
  messageId: '01900000-0000-7000-8000-000000000002',
  answer: 'Fixed by deduplicating events [1].',
  citations: [
    {
      n: 1,
      sourceType: 'ISSUE',
      title: 'PAY-1: Double charge',
      url: '/projects/PAY/issues/PAY-1',
      projectKey: 'PAY',
      headingPath: null,
    },
  ],
};

describe('streamChat', () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it('reports the conversation, the text as it streams, a tool step, then the answer', async () => {
    apiFetch.mockResolvedValue(
      sse([
        ['conversation', { conversationId: result.conversationId }],
        ['tool', { name: 'query_issues', description: 'Looking up done bugs in PAY' }],
        ['delta', { text: 'Fixed by ' }],
        ['delta', { text: 'deduplicating' }],
        ['result', result],
      ]),
    );
    const seen: string[] = [];
    const answer = await streamChat(
      { message: 'Why?', projectId: 'p' },
      {
        onConversation: (id) => seen.push(`conversation ${id}`),
        onTool: (description) => seen.push(`tool ${description}`),
        onText: (text) => seen.push(`text ${text}`),
      },
    );

    expect(answer).toEqual(result);
    expect(seen).toEqual([
      `conversation ${result.conversationId}`,
      'tool Looking up done bugs in PAY',
      'text Fixed by ',
      'text Fixed by deduplicating',
    ]);
    expect(apiFetch).toHaveBeenCalledWith(
      '/ai/chat',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ message: 'Why?', projectId: 'p' }),
      }),
    );
  });

  it('rejects with the server message on an error event', async () => {
    apiFetch.mockResolvedValue(
      sse([['error', { code: 'provider_unavailable', message: 'The AI provider is busy.' }]]),
    );
    await expect(streamChat({ message: 'Why?' })).rejects.toThrow('The AI provider is busy.');
  });

  it('rejects when the stream ends without an answer', async () => {
    apiFetch.mockResolvedValue(sse([['delta', { text: 'Half an ans' }]]));
    await expect(streamChat({ message: 'Why?' })).rejects.toThrow(/interrupted/);
  });
});
