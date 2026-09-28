import { isValidWebhookSignature, signWebhookBody } from './webhook-signature';

const secret = 'test-webhook-secret-0123456789';
const body = Buffer.from('{"zen":"Keep it logically awesome."}');

describe('isValidWebhookSignature', () => {
  it('accepts the signature GitHub computes for the exact body', () => {
    expect(isValidWebhookSignature(secret, body, signWebhookBody(secret, body))).toBe(true);
  });

  it("matches the example in GitHub's webhook documentation", () => {
    // docs.github.com "Validating webhook deliveries": secret "It's a Secret to Everybody",
    // payload "Hello, World!".
    expect(
      isValidWebhookSignature(
        "It's a Secret to Everybody",
        Buffer.from('Hello, World!'),
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      ),
    ).toBe(true);
  });

  it.each([
    ['a missing header', undefined],
    ['an empty header', ''],
    ['the legacy SHA-1 header format', `sha1=${'0'.repeat(40)}`],
    ['a signature made with another secret', signWebhookBody('another-secret-value-000', body)],
    ['a truncated signature', signWebhookBody(secret, body).slice(0, -2)],
    ['a non-hex signature', `sha256=${'z'.repeat(64)}`],
  ])('rejects %s', (_, header) => {
    expect(isValidWebhookSignature(secret, body, header)).toBe(false);
  });

  it('rejects a body changed by a single byte', () => {
    const signature = signWebhookBody(secret, body);
    const tampered = Buffer.from(body);
    tampered[2] = tampered[2] === 0x61 ? 0x62 : 0x61;
    expect(isValidWebhookSignature(secret, tampered, signature)).toBe(false);
  });

  it('rejects a body that was re-serialised (whitespace differs)', () => {
    const signature = signWebhookBody(secret, body);
    const reformatted = Buffer.from(JSON.stringify(JSON.parse(body.toString()), null, 2));
    expect(isValidWebhookSignature(secret, reformatted, signature)).toBe(false);
  });
});
