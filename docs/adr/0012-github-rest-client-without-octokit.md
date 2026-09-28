# ADR-0012: A small GitHub REST client instead of Octokit

- **Status:** Accepted
- **Date:** 2026-09-28
- **Refines:** [ADR-0008](0008-github-app-integration.md), which said calls would go through
  Octokit with its throttling and retry plugins.

## Context

Octokit's current packages are ESM-only. The API and its Jest setup are CommonJS
([ADR-0009](0009-toolchain-versions.md)), and loading ESM-only packages there means either
experimental loaders or a second module system in the tests. Forge only reads GitHub: a handful
of GET endpoints plus minting installation tokens.

## Decision

- `GithubClient` (apps/api/src/github) covers exactly what Forge uses:
  - the App JWT, RS256, signed with `node:crypto`;
  - installation tokens cached in Redis until five minutes before they expire, dropped on a 401
    or an uninstall;
  - `Link` pagination, followed only on the configured API origin;
  - the rate-limit handling Octokit's throttling plugin would have given.
- Rate limits (FR-6.5):
  - Each installation's remaining quota, taken from `X-RateLimit-*`, is stored in Redis and
    shared by the API and every worker.
  - Background work stops at a configurable reserve, before GitHub would refuse.
  - Primary and secondary limits become a `GithubRateLimitError` carrying the reset time. The
    job is moved back to the delayed set until then, without spending a retry.
- Repositories are addressed through the documented `/repos/{owner}/{repo}` routes. Renames are
  picked up from every webhook and from each sync's metadata refresh, keyed on GitHub's numeric
  repository ID.
- Webhook handlers use only the payload and make no GitHub API calls. PR and issue writes apply
  only when GitHub's `updated_at` is newer, so deliveries that arrive out of order are harmless.
- Only repositories linked to a project are synced.

## Alternatives considered

- **Octokit through dynamic `import()`.** It works at runtime but not under Jest's CommonJS
  transform without extra configuration, and the typed client ends up behind `any`.
- **Moving the API to ESM.** A toolchain change across every package, which is out of proportion
  for one integration.

## Consequences

- ➕ No new dependencies. Every behaviour Forge relies on is visible in about 250 lines, and it is
  unit-tested (JWT, token cache, pagination, rate limits, origin guard).
- ➕ The tests replay responses recorded from GitHub
  (`apps/api/test/fixtures/github/record.sh`) through a fake API that checks the App JWT and
  installation tokens the way GitHub does.
- ➖ New endpoints need a hand-written call and a Zod schema. That is acceptable for a read-only
  integration of this size; revisit it if Forge starts writing to GitHub widely.
