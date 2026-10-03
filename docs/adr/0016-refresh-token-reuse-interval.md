# ADR-0016: A short reuse interval for rotated refresh tokens

- **Status:** Accepted
- **Date:** 2026-10-02
- **Amends:** [ADR-0003](0003-auth-tokens.md) (rotation with reuse detection)

## Context

Every refresh consumes the presented refresh token and issues a successor in the same family.
Until now, a consumed token presented again within 10 seconds answered **409** ("another tab
refreshed; retry"), and after 10 seconds it revoked the whole family as a likely theft.

The browser end-to-end suite (Phase 13) found a case that design missed. When a page is reloaded
or navigated away from while a refresh is in flight, the browser cancels the request after the
server has already rotated the token. The `Set-Cookie` with the successor is never applied, so
the browser still holds the consumed token. Its next refresh got 409, the retry got 409 again,
and the person was sent to the sign-in page. Ten seconds later, a further attempt counted as
theft and revoked the session everywhere. Pressing F5 twice was enough to sign someone out.

## Decision

Within `REUSE_GRACE_MS` (10 seconds) of its first use, a consumed refresh token is exchanged
again for a **new** token in the same family. Two tabs that refresh at the same moment each get
one too. After the interval, presenting it still revokes the whole family and is audit-logged
(`auth.refresh.reuse_detected`), as before. The 409 response and the client's retry are removed.

This is the "reuse interval" (Auth0) or "grace period" (Okta) of refresh token rotation.

## Consequences

- A reload or concurrent tabs can no longer sign a person out.
- A stolen refresh token replayed within 10 seconds of the legitimate refresh is accepted. The
  token is an `HttpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/auth`, so stealing it
  already requires access to the browser or its storage. A replay after the interval is still
  detected, and logging out, changing the password or "sign out everywhere" still revoke every
  token in the family.
- Tested both ways in `auth.int-spec.ts`: a refresh whose response was lost keeps the session,
  two simultaneous refreshes both succeed, and a replay after the interval revokes the family.
  Breaking either rule makes a test fail.
