/**
 * The Content Security Policy for every page. Scripts run only with this response's nonce
 * ('strict-dynamic' lets Next.js's own loader add its chunks), so injected markup cannot run
 * script even if a sanitiser were bypassed. Kept dependency-free: the proxy imports it.
 */
export interface CspOptions {
  nonce: string;
  /** `next dev` needs eval for React's debugging features and fast refresh. */
  dev: boolean;
  /** Where browsers PUT uploads (pre-signed URLs point at object storage, not the app). */
  storageOrigin?: string | undefined;
}

export function contentSecurityPolicy({ nonce, dev, storageOrigin }: CspOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [`'nonce-${nonce}'`, "'strict-dynamic'", ...(dev ? ["'unsafe-eval'"] : [])],
    // <style> elements need the nonce. React renders a few computed style attributes (label
    // colours, chart positions); attributes cannot run script, so they are allowed.
    'style-src': ["'self'", `'nonce-${nonce}'`],
    'style-src-attr': ["'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...(storageOrigin ? [storageOrigin] : [])],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/**
 * The origin of the object storage endpoint browsers upload to, or undefined. `STORAGE_ORIGIN`
 * is set wherever the app is deployed; local development falls back to the compose SeaweedFS.
 */
export function storageOrigin(env: Record<string, string | undefined>): string | undefined {
  const configured = env.STORAGE_ORIGIN;
  if (configured) return new URL(configured).origin;
  return env.NODE_ENV === 'production' ? undefined : 'http://localhost:8333';
}

/** 128 bits from the platform CSPRNG, base64-encoded as CSP requires. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
