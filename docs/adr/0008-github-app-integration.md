# ADR-0008: GitHub App integration with webhooks and reconciliation

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Forge reads repositories, PRs, commits, contributors and issues, needs to learn about new PRs
promptly, and may optionally post review comments.

## Decision

- Integrate as a **GitHub App** with fine-grained, read-only permissions (Contents, Pull requests,
  Issues, Metadata), plus Pull requests: write only for the opt-in comment feature.
- Authenticate with the App's private key → short-lived **installation access tokens** (1 h),
  cached in Redis. The private key is stored in SSM or env and never in the DB.
- **Webhooks** (`pull_request`, `push`, `issues`, `installation`) arrive at
  `POST /api/v1/webhooks/github`. The endpoint verifies `X-Hub-Signature-256` over the raw body
  with a constant-time compare, stores the delivery ID for deduplication, enqueues a job and
  returns `202` quickly.
- An hourly **reconciliation** job catches missed webhooks. Local development either uses smee.io
  to forward webhooks or relies on reconciliation alone.
- All calls go through Octokit with the throttling and retry plugins.

## Alternatives considered

- **Personal access token.** Tied to one human, too broadly scoped, and no webhooks for other
  users' repositories. Acceptable only as a local-dev shortcut behind the same adapter interface.
- **OAuth App.** Acts as the user with broad `repo` scope. A GitHub App's installation-scoped,
  least-privilege model is GitHub's recommended approach for integrations.
- **Polling only.** Simple, but slow to reflect new PRs and wasteful of rate limit.

## Consequences

- ➕ Least privilege, org-installable, higher rate limits, and real-time updates.
- ➖ More setup (App registration, private key, webhook secret), documented step by step in
  [`docs/github-app-setup.md`](../github-app-setup.md).

## Implementation notes (Phase 8)

- **A small REST client instead of Octokit.** Octokit's current packages are ESM-only, while the
  API and its Jest setup are CommonJS (ADR-0009). Forge needs a handful of GET endpoints, so
  `GithubClient` covers exactly that: App JWT (RS256, signed with `node:crypto`), installation
  tokens cached in Redis, `Link` pagination, and the rate-limit handling Octokit's throttling
  plugin would have given. Rate limits become a `GithubRateLimitError` with the reset time, and
  the worker re-delays the job without spending a retry. Background work also stops at a
  configurable reserve, before GitHub would refuse.
- **Webhooks cost no API calls.** Handlers use only the payload; out-of-order deliveries are
  harmless because PR and issue writes apply only when GitHub's `updated_at` is newer.
- **Repositories are addressed as `/repos/{owner}/{repo}`.** These are the documented routes.
  Renames are picked up from every webhook and from each sync's metadata refresh, keyed on
  GitHub's numeric repository ID.
- **Only linked repositories are synced**, which keeps rate-limit use proportional to what
  projects actually use.
- Tests replay responses recorded from GitHub (`apps/api/test/fixtures/github/record.sh`)
  through a fake API that checks the App JWT and installation tokens as GitHub does.
