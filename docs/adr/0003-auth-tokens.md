# ADR-0003: Access and refresh token strategy

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

The brief requires JWT authentication with refresh tokens. Where tokens live determines exposure
to XSS and CSRF, and whether sessions can be revoked.

## Decision

- **Access token:** JWT, 15 min, EdDSA-signed with a `kid` header for key rotation. Claims are
  kept minimal (`sub`, `isAdmin`, `iat`, `exp`, `jti`); project roles are _not_ in the token
  because they change and are looked up (cached) per request. Held **in memory** by the
  frontend.
- **Refresh token:** opaque 256-bit random value, stored in the DB as a SHA-256 hash, 7-day
  expiry, sent as an `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth` cookie. It is
  **rotated on every use**, and each token belongs to a `family_id`. Presenting an
  already-rotated token revokes the whole family (reuse detection).
- **Passwords:** argon2id (OWASP-recommended parameters). Reset tokens are single-use, hashed
  and expire in 30 min.

## Alternatives considered

- **Access token in `localStorage`.** Rejected: any XSS can exfiltrate it.
- **Server sessions only (no JWT).** Simpler and fully revocable, but the brief asks for JWT.
  A 15-minute JWT with DB-backed refresh gets most of the revocability back (a revocation takes
  effect within 15 minutes).
- **Refresh JWT instead of an opaque token.** No benefit, because it has to be checked against
  the DB to rotate and revoke anyway.

## Consequences

- ➕ XSS cannot read either token (the access token only exists in JS memory while the page is
  open, and there is no persistent store to steal). Stolen refresh tokens are detected on reuse.
- ➖ A page reload needs a `/refresh` call before the first authenticated request. That is one
  fast round trip, and Next.js middleware makes it transparent.
