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
| Refresh tokens       | 256-bit random, stored as SHA-256, rotated on every use, theft detection by family revocation (after a 10 s reuse interval, ADR-0016), httpOnly + Secure + SameSite=Strict cookie scoped to `/api/v1/auth`                             | `auth.int-spec.ts`                                  |
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
- **Archived projects are read-only.** The guard answers `409` for every permission except
  reading and restoring, so no feature can forget the check.
- **A project always has a manager.** Demotions and removals lock the project row, so two
  managers demoting each other concurrently cannot leave it with none (tested with a mutation:
  without the lock, the race test fails).
- **Comments** can be edited or deleted only by their author or by a role with
  `comment:moderate`; deleted comment text is never returned again.
- **Lost updates are impossible.** Issue edits carry the version the user saw and are applied
  with a conditional update, so a stale edit gets `409` instead of overwriting someone else's
  change (tested with a mutation: without the version check, the race test fails).
- **User-written Markdown** (descriptions, comments) is rendered without raw HTML, and links open
  with `rel="noopener noreferrer nofollow"`.
- **Irreversible actions are gated twice.** Deleting a project requires a platform admin, a
  project that is already archived, and the project key repeated as `?confirm=`.
- **Mass assignment.** Every request body is parsed by a Zod schema, and unknown keys (such as
  `isAdmin` on registration or a profile update) are dropped.

## File uploads

| Control                  | Implementation                                                                                                                            | Verified by                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| No bytes through the API | Browser → storage via pre-signed PUT (10 min); downloads via pre-signed GET (60 s) issued only after the project permission check         | `attachments.int-spec.ts`                       |
| Size and type            | 10 MB and a type allow-list (no HTML, SVG, XML or script types) checked by the API; size, type and disposition signed into the upload URL | `attachments.int-spec.ts` (storage returns 403) |
| Trust but verify         | On completion the API reads the stored object's size and type; a mismatch deletes the object and the record (tested with a mutation)      | `attachments.int-spec.ts`                       |
| Served as downloads      | Every object is stored with `Content-Disposition: attachment` and an RFC 6266 file name; storage is a separate origin from the app        | `content-disposition.spec.ts`, browser run      |
| Path and header safety   | File names are stripped of paths, control characters and quotes; storage keys are random UUIDs, never user input                          | `attachments.test.ts` (types)                   |
| Cross-origin uploads     | Bucket CORS allows only the web origin for PUT and GET                                                                                    | verified against SeaweedFS (ADR-0011)           |
| Abandoned uploads        | Hourly worker job deletes uploads not completed within an hour, from storage and the database                                             | `attachments.int-spec.ts`                       |

## GitHub integration

| Control                  | Implementation                                                                                                                                                       | Verified by                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Webhook authenticity     | HMAC-SHA256 over the **raw** request bytes (a route-scoped raw body parser, 5 MB), constant-time compare; no user token accepted there                               | `webhook-signature.spec.ts` (GitHub's test vector), `github.int-spec.ts`, mutation |
| Replay and redelivery    | The delivery ID is the primary key of `github_webhook_deliveries` and the job ID, so a delivery is processed once                                                    | `github.int-spec.ts`                                                               |
| Untrusted payloads       | Every GitHub response and webhook is parsed with Zod; a malformed payload is recorded and not retried                                                                | `github.int-spec.ts`                                                               |
| Least privilege          | Read-only repository permissions; installation tokens (1 h) cached in Redis until 5 min before expiry, dropped on 401 or uninstall; the private key stays in env/SSM | `github.client.spec.ts`                                                            |
| Claiming installations   | Admin only, and the ID is confirmed with GitHub as the App: an ID from another App's installation is a 404 and never stored                                          | `github.int-spec.ts`                                                               |
| No cross-project leakage | A key resolves only in projects that linked the repository; responses list only the caller's project's keys; unlinking removes that project's links                  | `github.int-spec.ts`, mutation                                                     |
| Token confinement        | Pagination `Link` headers are only followed on the configured API origin, so a tampered header cannot send the token elsewhere                                       | `github.client.spec.ts`                                                            |
| External links           | PR and commit links open with `target=_blank rel="noopener noreferrer"`                                                                                              | `github.test.tsx`                                                                  |

## AI features (OWASP LLM Top 10)

| Risk                                    | Control                                                                                                                                                                                                                                                                                                                                                       | Verified by                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Prompt injection (direct or indirect)   | User, issue and comment text only enters prompts inside `<untrusted_input>` blocks, and any tag inside it is neutralised so it cannot close the block. The system prompt says the block is data, never instructions                                                                                                                                           | `test_prompts.py` (injection cannot escape its block)                          |
| Insecure output handling                | Model output is validated against a strict JSON Schema and Pydantic, repaired at most once, then Zod-validated by the API and the web app. It is only shown or used to fill a form, never executed                                                                                                                                                            | `test_structured.py`, `ai.wire.spec.ts`                                        |
| Excessive agency                        | The model cannot write anything. Drafts fill a form the person must submit; labels outside the project's list are dropped. Chat has one read-only tool, `query_issues`, which the API executes: its arguments are Zod-validated and it only searches projects the caller can read, whatever key the model names                                               | `create-issue-dialog.test.tsx`, `ai.int-spec.ts`, `search.int-spec.ts`         |
| Unbounded consumption                   | 20 requests a minute per person; a daily token budget per person; a prompt input cap (`AI_MAX_INPUT_TOKENS`) that drops the oldest comments first; output token caps; a review sends at most 60 files and about 60k tokens of diff, skipping lockfiles, generated and vendored code                                                                           | `ai.int-spec.ts` (budget, mutation-checked), `test_feature_api.py`             |
| Sensitive information disclosure        | Summaries only read an issue the caller may see (project RBAC on the route). Provider error text is logged, not shown: users get a fixed message                                                                                                                                                                                                              | `ai.int-spec.ts` (mutation-checked)                                            |
| Cross-project leakage through RAG       | Every chunk carries its `project_id`; every retrieval query filters `project_id = ANY($projects)` in SQL, with the list resolved by the API from memberships on each request (an empty list returns nothing). The API drops any result or citation outside that list as a second check. The AI service's database role can read and write only the RAG tables | `test_rag_db.py` (search and chat), `search.int-spec.ts`, least-privilege test |
| Indirect injection through indexed data | Retrieved chunks, tool results and titles are fenced as untrusted input; citations are mapped back to the sources actually shown, and invented numbers are removed from the answer                                                                                                                                                                            | `test_answer.py`                                                               |
| Injection through pull requests         | PR titles, descriptions and diffs are fenced as untrusted input; the prompt tells the model to review instructions in them as text, never follow them. Output is schema-validated, and line numbers outside the diff are discarded. The review is only displayed, under a disclaimer, and never posted to GitHub (ADR-0015)                                   | `test_review.py`, `reviews.int-spec.ts`                                        |
| Service-to-service trust                | The AI service accepts only the shared service token (constant-time compare) and is never exposed publicly                                                                                                                                                                                                                                                    | `test_security.py`, `test_feature_api.py`                                      |

Uploaded documents are text only (Markdown or plain text, at most 1 MB, sent as JSON and rendered
with the same sanitising Markdown renderer as comments). Only those two routes accept bodies above
the default 100 kB limit.

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
`auth.password_reset.completed`, `auth.password_changed`, `admin.user.updated` (with
before/after values), `project.created`, `project.updated` (only the fields that changed),
`project.archived`, `project.restored`, `project.deleted`, and `project.member.added`,
`.role_changed`, `.removed` and `.left`. (Issue, comment and attachment changes are recorded
in each issue's own history instead.) Each entry has the actor, IP, user agent and request ID.

## Supply chain and images

| Control               | Implementation                                                                                                                                | Tested by                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| CI actions            | Every GitHub Action pinned to a full commit SHA; workflows default to `contents: read`; no long-lived secrets (GHCR uses the job token)       | `actionlint`; review of `.github/workflows`  |
| Vulnerable components | Trivy scans every image on every PR and on main; any fixable High or Critical fails the images that serve traffic ([cicd.md](cicd.md))        | `images.yml` gate                            |
| Image provenance      | Images published from `main` only, with an SBOM, BuildKit provenance and a Sigstore-signed build attestation; deploy by `sha-<commit>` digest | `gh attestation verify` ([cicd.md](cicd.md)) |
| Container hardening   | Non-root users in every container; no npm, corepack or yarn in runtime images; no build tooling or package caches in runtime images           | `docker compose exec … id`; Trivy            |
| Dependency updates    | Dependabot for npm, uv, GitHub Actions, compose images and Dockerfile base images, weekly                                                     | `.github/dependabot.yml`                     |

## Deliberate trade-offs

| Decision                                                                | Why                                                                                                                                                                                                  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Registration returns 409 for an existing email                          | Registration inherently reveals account existence unless email verification is added (future). Rate-limited to 5/min/IP                                                                              |
| Rate limiting, lockout and revocation checks fail open if Redis is down | A cache outage should degrade abuse protection, not take authentication offline. Refresh still checks the database                                                                                   |
| One-second revocation window                                            | `iat` has one-second resolution (ADR-0010)                                                                                                                                                           |
| The session-hint cookie (`forge_session`) is readable by JavaScript     | It holds no credential (the value is `1`); it only lets the web proxy redirect before rendering                                                                                                      |
| Every GitHub installation belongs to the deployment                     | v1 is single-organisation: any installation of this App is the organisation's, and project managers may link any of its repositories                                                                 |
| The migrate image may ship two High findings that Prisma pins           | `mysql2` and `deepmerge-ts` are exact dependencies of the Prisma CLI; overriding them runs Prisma on untested versions. The image is a one-shot job with no listener; Criticals still fail the build |
