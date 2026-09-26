# ADR-0010: ES256 access tokens via @nestjs/jwt, with a per-user revocation cutoff

- **Status:** Accepted (refines ADR-0003)
- **Date:** 2026-09-26

## Context

ADR-0003 chose short-lived signed JWTs with an asymmetric key pair and named EdDSA as the
algorithm. Implementing it (Phase 4) raised two concrete problems:

1. **Library.** `jose`, the usual choice for EdDSA, is ESM-only since v6. The API is CommonJS
   and tested with Jest (ADR-0009), where loading ESM needs experimental flags. The official
   `@nestjs/jwt` (built on `jsonwebtoken`, CommonJS) does not support EdDSA.
2. **Revocation.** A 15-minute token that cannot be revoked means a deactivated user, or a
   demoted admin, keeps access for up to 15 minutes.

## Decision

- Sign access tokens with **ES256** (ECDSA P-256) through `@nestjs/jwt`. It is still an
  asymmetric pair: only the API holds the private key, a `kid` header identifies the key for
  rotation, and verification pins `algorithms: ['ES256']`, the issuer and the audience
  (preventing algorithm-confusion attacks).
- Keep a **per-user revocation cutoff** in Redis: `auth:revoked-user:{id} = <unix seconds>`
  with a TTL of one access-token lifetime. The auth guard rejects tokens whose `iat` is at or
  before the cutoff. It is set on deactivation, admin promotion or demotion, logout-everywhere,
  password change and password reset.
- The cutoff sits one second in the past, because `iat` has one-second resolution and the new
  session issued by a password change must stay valid. Tokens issued in the same second as a
  revocation survive; that one-second window is accepted.

## Alternatives considered

- **EdDSA through `jose` with a Jest ESM transform.** Works, but it is fragile configuration for
  no security benefit: ES256 and Ed25519 give the same practical protection here.
- **Hand-written JWT signing on `node:crypto`.** Rejected: validating JWTs correctly is where
  subtle bugs live, and a maintained library exists.
- **Checking the user row on every request.** Correct, but it adds a database read to every API
  call. A single Redis `GET` gives the same guarantee for the cases that matter.
- **Deny-listing individual token IDs (`jti`).** Needs one entry per token, and the operations
  that revoke (deactivate, demote) apply to all of a user's tokens anyway.

## Consequences

- ➕ Deactivation, demotion and "log out everywhere" take effect on the next request.
- ➕ The revocation state is tiny (one key per revoked user) and expires by itself.
- ➖ If Redis is unreachable, the check fails open, falling back to the 15-minute expiry. Refresh
  still re-checks the database, so a revoked user cannot obtain a new token.
