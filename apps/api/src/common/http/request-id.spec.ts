import type { IncomingMessage, ServerResponse } from 'node:http';

import { REQUEST_ID_HEADER, resolveRequestId } from './request-id';

function call(header?: string | string[]) {
  const req = { headers: header === undefined ? {} : { [REQUEST_ID_HEADER]: header } };
  const setHeader = jest.fn();
  const id = resolveRequestId(req as IncomingMessage, { setHeader } as unknown as ServerResponse);
  return { id, setHeader };
}

describe('resolveRequestId', () => {
  it('reuses a well-formed upstream request ID and echoes it', () => {
    const { id, setHeader } = call('abc-123_x.y');
    expect(id).toBe('abc-123_x.y');
    expect(setHeader).toHaveBeenCalledWith(REQUEST_ID_HEADER, 'abc-123_x.y');
  });

  it('generates a UUID when none is supplied', () => {
    expect(call().id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it.each(['has spaces', 'line\nbreak', 'x'.repeat(129), ''])(
    'replaces an unsafe upstream value (%j)',
    (value) => {
      const { id } = call(value);
      expect(id).not.toBe(value);
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );

  it('uses the first value when the header is repeated', () => {
    expect(call(['first', 'second']).id).toBe('first');
  });
});
