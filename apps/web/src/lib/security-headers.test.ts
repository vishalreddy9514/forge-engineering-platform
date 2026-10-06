/** @jest-environment node */
import { contentSecurityPolicy, storageOrigin } from './security-headers';

describe('contentSecurityPolicy', () => {
  it('lets the browser upload only to the configured object storage', () => {
    const policy = contentSecurityPolicy({
      nonce: 'n',
      dev: false,
      storageOrigin: 'https://forge-attachments.s3.eu-west-2.amazonaws.com',
    });
    expect(policy).toContain(
      "connect-src 'self' https://forge-attachments.s3.eu-west-2.amazonaws.com;",
    );
  });

  it('allows eval only for the development server', () => {
    expect(contentSecurityPolicy({ nonce: 'n', dev: true })).toContain("'unsafe-eval'");
    expect(contentSecurityPolicy({ nonce: 'n', dev: false })).not.toContain("'unsafe-eval'");
  });

  it('allows inline style attributes but not inline style elements', () => {
    const policy = contentSecurityPolicy({ nonce: 'n', dev: false });
    expect(policy).toContain("style-src 'self' 'nonce-n';");
    expect(policy).toContain("style-src-attr 'unsafe-inline'");
  });
});

describe('storageOrigin', () => {
  it('reduces the configured endpoint to its origin', () => {
    expect(storageOrigin({ STORAGE_ORIGIN: 'http://localhost:8333/forge-attachments' })).toBe(
      'http://localhost:8333',
    );
  });

  it('falls back to the local SeaweedFS outside production, and to nothing in it', () => {
    expect(storageOrigin({ NODE_ENV: 'development' })).toBe('http://localhost:8333');
    expect(storageOrigin({ NODE_ENV: 'production' })).toBeUndefined();
  });
});
