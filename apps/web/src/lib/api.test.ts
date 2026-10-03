import {
  apiFetch,
  ApiError,
  refreshSession,
  setAccessToken,
  setSessionExpiredHandler,
} from './api';

const session = (token: string) => ({
  accessToken: token,
  expiresIn: 900,
  user: {
    id: '01920000-0000-7000-8000-000000000001',
    email: 'sam@forge.local',
    displayName: 'Sam',
    avatarUrl: null,
    isAdmin: false,
    createdAt: '2026-09-26T10:00:00.000Z',
  },
});

const json = (status: number, body: unknown) =>
  Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) } as Response);

function authHeader(call: unknown[]): string | null {
  return new Headers((call[1] as RequestInit).headers).get('Authorization');
}

describe('api client', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    global.fetch = fetchMock;
    fetchMock.mockReset();
    setAccessToken('old-token');
    setSessionExpiredHandler(undefined);
  });

  it('sends the in-memory access token', async () => {
    fetchMock.mockReturnValueOnce(json(200, {}));
    await apiFetch('/users/me');
    expect(authHeader(fetchMock.mock.calls[0] as unknown[])).toBe('Bearer old-token');
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    fetchMock
      .mockReturnValueOnce(json(401, {}))
      .mockReturnValueOnce(json(200, session('new-token')))
      .mockReturnValueOnce(json(200, { ok: true }));

    const res = await apiFetch('/users/me');

    expect(res.status).toBe(200);
    expect((fetchMock.mock.calls[1] as unknown[])[0]).toBe('/api/v1/auth/refresh');
    expect(authHeader(fetchMock.mock.calls[2] as unknown[])).toBe('Bearer new-token');
  });

  it('shares one refresh between concurrent 401s (the server rotates the cookie each time)', async () => {
    let refreshCalls = 0;
    fetchMock.mockImplementation((url: string, init: RequestInit) => {
      if (url === '/api/v1/auth/refresh') {
        refreshCalls++;
        return json(200, session('new-token'));
      }
      const token = new Headers(init.headers).get('Authorization');
      return json(token === 'Bearer new-token' ? 200 : 401, {});
    });

    await Promise.all([apiFetch('/a'), apiFetch('/b'), apiFetch('/c')]);
    expect(refreshCalls).toBe(1);
  });

  it('treats a failed refresh as signed out, without retrying it', async () => {
    fetchMock.mockReturnValueOnce(json(401, {}));
    await expect(refreshSession()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an expired session when refresh fails, and surfaces the 401', async () => {
    const expired = jest.fn();
    setSessionExpiredHandler(expired);
    fetchMock.mockReturnValueOnce(json(401, {})).mockReturnValueOnce(json(401, {}));

    await expect(apiFetch('/users/me')).rejects.toMatchObject({ status: 401 });
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('throws ApiError carrying the problem details', async () => {
    fetchMock.mockReturnValueOnce(
      json(400, { type: 'about:blank', title: 'Bad Request', status: 400, detail: 'Nope' }),
    );
    const error = await apiFetch('/x', {}, { auth: false }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Nope');
  });
});
