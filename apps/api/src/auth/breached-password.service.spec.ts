import type { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import type { Env } from '../config/env';
import { BreachedPasswordService } from './breached-password.service';

const config = (enabled: boolean) =>
  ({ get: () => enabled }) as unknown as ConfigService<Env, true>;

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex').toUpperCase();

describe('BreachedPasswordService', () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    global.fetch = fetchMock;
    fetchMock.mockReset();
  });

  it('sends only the 5-character hash prefix (k-anonymity) and matches the suffix', async () => {
    const hash = sha1('password123');
    fetchMock.mockResolvedValue({
      ok: true,
      text: () =>
        Promise.resolve(`0000000000000000000000000000000000A:0\r\n${hash.slice(5)}:12345\r\n`),
    });

    await expect(new BreachedPasswordService(config(true)).isBreached('password123')).resolves.toBe(
      true,
    );
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`);
    expect(url).not.toContain(hash.slice(5));
  });

  it('ignores padding entries with a zero count', async () => {
    const hash = sha1('a unique enough passphrase');
    fetchMock.mockResolvedValue({ ok: true, text: () => Promise.resolve(`${hash.slice(5)}:0`) });
    await expect(
      new BreachedPasswordService(config(true)).isBreached('a unique enough passphrase'),
    ).resolves.toBe(false);
  });

  it('fails open when the API is unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(new BreachedPasswordService(config(true)).isBreached('whatever')).resolves.toBe(
      false,
    );
  });

  it('does nothing when disabled', async () => {
    await expect(new BreachedPasswordService(config(false)).isBreached('x')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
