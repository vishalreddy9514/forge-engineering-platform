# Security

> What is implemented today, and the trade-offs that were chosen deliberately. The threat model
> and OWASP mappings are in [architecture §6](architecture.md#6-security-architecture);
> hardening continues in Phase 18.

## Authentication

| Control              | Implementation                                                                                                                                                                                                                         | Verified by                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Password storage     | argon2id, 19 MiB / t=2 / p=1 (OWASP baseline), PHC strings so parameters can be raised later                                                                                                                                           | `password-hasher.spec.ts`                           |
| Password policy      | 12–128 characters, no composition rules (NIST SP 800-63B); breached passwords rejected via the HIBP k-anonymity API (only 5 hash characters leave the server; fails open)                                                              | `auth.test.ts`, `breached-password.service.spec.ts` |
| Access tokens        | ES256 JWT, 15 min, `kid`, pinned algorithm, issuer and audience; memory-only in the browser                                                                                                                                            | `app.e2e-spec.ts` (forged `alg: none` rejected)     |
| Refresh tokens       | 256-bit random, stored as SHA-256, rotated on every use, theft detection by family revocation, httpOnly + Secure + SameSite=Strict cookie scoped to `/api/v1/auth`                                                                     | `auth.int-spec.ts`                                  |
| Immediate revocation | Redis cutoff per user (ADR-0010) on deactivation, role change, logout-everywhere, password change and reset                                                                                                                            | `admin-and-rbac.int-spec.ts`, `auth.int-spec.ts`    |
| Brute force          | Per-account (5 / 15 min) and per-IP (20 / 15 min) lockout with `Retry-After`; route rate limits                                                                                                                                        | `auth.int-spec.ts`                                  |
| User enumeration     | Same error for an unknown email and a wrong password; dummy argon2 verification for unknown emails (equal timing); lockout applies to non-existent accounts; password-reset requests always return 202, with email sent asynchronously | `auth.int-spec.ts`                                  |
| Password reset       | Single-use, 30-minute, hashed tokens; newest link only; signs out all sessions; `Referrer-Policy: no-referrer` on the reset page and the token removed from the address bar                                                            | `auth.int-spec.ts`, browser run                     |
| CSRF                 | SameSite=Strict, a narrow cookie path, and an `Origin` allow-list on cookie-authenticated endpoints                                                                                                                                    | `auth.int-spec.ts`                                  |

## Authorisation

- **Secure by default.** A global guard requires a valid access token on every route. Public
  routes must opt out explicitly with `@Public()`.
- **Project RBAC.** Permissions are defined in code and the full matrix is tested
  (`permissions.spec.ts`) and exercised over HTTP for every role (`admin-and-rbac.int-spec.ts`).
  Non-members get 404, so project IDs cannot be probed. Memberships are cached in Redis for
  60 seconds and invalidated on change.
- **Admin routes** re-check `isAdmin` in the database instead of trusting the token claim.
- **Mass assignment.** Every request body is parsed by a Zod schema, and unknown keys (such as
  `isAdmin` on registration or a profile update) are dropped.

## Data protection in logs

- The request logger records an allow-list (`id`, `method`, `url`, `userAgent`), never raw
  headers. Found by testing: the `Referer` header from the reset page carried the reset token.
- Pino redaction covers `authorization`, `cookie`, `set-cookie`, `referer` and any `password`,
  `token` or `resetUrl` fields as a second line of defence.
- `/health/ready` reports "Unavailable" rather than driver errors, which name internal hosts.
- Email jobs, which contain reset links, are removed from Redis as soon as they are delivered.

## Audit log

Append-only (database triggers reject UPDATE, DELETE and TRUNCATE). Recorded today:
`auth.register`, `auth.login.succeeded`, `auth.login.failed` (with reason), `auth.logout`,
`auth.logout_all`, `auth.refresh.reuse_detected`, `auth.password_reset.requested`,
`auth.password_reset.completed`, `auth.password_changed`, and `admin.user.updated` (with
before/after values). Each entry has the actor, IP, user agent and request ID.

## Deliberate trade-offs

| Decision                                                                | Why                                                                                                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Registration returns 409 for an existing email                          | Registration inherently reveals account existence unless email verification is added (future). Rate-limited to 5/min/IP |
| Rate limiting, lockout and revocation checks fail open if Redis is down | A cache outage should degrade abuse protection, not take authentication offline. Refresh still checks the database      |
| One-second revocation window                                            | `iat` has one-second resolution (ADR-0010)                                                                              |
| The session-hint cookie (`forge_session`) is readable by JavaScript     | It holds no credential (the value is `1`); it only lets the web proxy redirect before rendering                         |
