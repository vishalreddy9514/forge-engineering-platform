# Testing

Every layer is tested against the real thing it depends on wherever that is practical:
Postgres and Redis through Testcontainers, the AI service through recorded contract files and
a deterministic fake model, and the whole product through a browser.

| Layer               | Where                                     | What it proves                                                                                 | Runs                       |
| ------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------- |
| Unit                | `*.spec.ts`, `*.test.ts(x)`, `tests/`     | Pure logic: burndown, diff parsing, file selection, permissions, schemas, components           | `pnpm test`                |
| API over HTTP       | `apps/api/test/app.e2e-spec.ts`           | Security headers, CORS, auth on every route, validation errors, rate-limit headers, OpenAPI    | `pnpm test`                |
| API integration     | `apps/api/test/integration/*.int-spec.ts` | Real Postgres (pgvector) and Redis: RBAC matrix, outbox, queues, GitHub fixtures, AI contracts | `pnpm test` (needs Docker) |
| AI service          | `apps/ai-service/tests`                   | Prompts, providers, RAG against real pgvector, the retrieval eval (hit-rate@5 ≥ 0.8)           | `pnpm test` (uv)           |
| Browser, end to end | `e2e/tests/*.spec.ts`                     | The critical journeys in a real browser against the built stack, with axe WCAG 2.1 AA checks   | `pnpm e2e`                 |

## Coverage (NFR-10)

`apps/api` measures its domain services (`src/**/*.service.ts`) over the unit and integration
suites together, in one run (`pnpm --filter @forge/api test:coverage`, which is what its `test`
script runs). CI fails below 90 % of lines, statements and functions overall, 75 % of branches,
or 80 % of lines in any single service.

Measured on 2026-10-02: lines 95.4 %, statements 93.1 %, functions 96.2 %, branches 78 %.
Branches are the weak spot (mostly defensive `??` fallbacks and error paths for outages), so the
branch threshold is set below 80 % rather than pretending otherwise.

## End-to-end journeys (Phase 13)

Playwright starts the AI service (fake provider), the API, the worker and the production build of
the web app on top of the docker compose infrastructure. Every test creates its own users and
project through the API, so the tests are independent and run in parallel.

| Journey                 | Covers                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `auth.spec.ts`          | Register, sign out, sign in; generic error for a wrong password; redirect back after signing in; public pages hydrate cleanly |
| `issues.spec.ts`        | Create a project and an issue, comment, change status, read the history, move the card on the board, reload                   |
| `sprints.spec.ts`       | Plan, fill, start and complete a sprint; the dashboard meter and velocity follow                                              |
| `collaboration.spec.ts` | An assignment notifies the developer (outbox → worker), who follows it; viewers are read-only; outsiders see nothing          |
| `ai.spec.ts`            | A streamed issue draft fills the form; the assistant answers from freshly indexed work and cites the issue                    |
| `accessibility.spec.ts` | Search, notifications, members, labels, settings, documents and code pages                                                    |
| `attachments.spec.ts`   | A file uploads to object storage and downloads intact through pre-signed URLs                                                 |
| `security.spec.ts`      | Every main page and an upload run under the CSP with no violation; markup in a description and injected script cannot run     |

Every page a journey passes through is checked with axe for WCAG 2.1 A and AA (NFR-13).

Not covered end to end: the AI service being down. The web app's `/api` proxy target is fixed
at build time, so that would need a second build and stack; degraded mode is covered by the API
integration tests (`ai.int-spec.ts`) and the web component tests instead.

Run locally:

```sh
pnpm infra:up
pnpm --filter @forge/api exec prisma migrate deploy
pnpm build
pnpm e2e                         # starts the services, runs the journeys
pnpm --filter @forge/e2e e2e:report   # the HTML report, with traces of any failure
```

The suite sets `RATE_LIMITS_ENABLED=false`: every page load refreshes the session from one
address, faster than any person would. The switch is refused when `NODE_ENV=production`, and
rate limiting itself is tested in `app.e2e-spec.ts`.

It also sets `HIBP_ENABLED=false`: the journeys share one fixed password, which is a known
breached one, and the run must not depend on the Pwned Passwords service. The lookup itself is
tested in `breached-password.service.spec.ts`. The containerised run in CI sets both through
`STACK_RATE_LIMITS_ENABLED` and `STACK_HIBP_ENABLED` ([docker](docker.md#verified)).

### What the journeys found

Writing them found real defects, each fixed with a test that fails without the fix:

- **Reloading during a session refresh signed people out.** The browser cancelled the response
  after the server had rotated the refresh token, so it kept the consumed one; the retry was
  refused, and a later attempt counted as theft. See
  [ADR-0016](adr/0016-refresh-token-reuse-interval.md).
- **Every public page failed to hydrate** (React #418 in production builds): `CardTitle`
  rendered an `<h3>` around the page's `<h1>`, and the HTML parser does not allow nested
  headings. `CardTitle` is now a `div`; pages choose the heading level.
- **WCAG contrast**: muted text on muted backgrounds was 4.39:1 (now 4.8:1), and the "Done" and
  "Open" badges were 3.08:1 (now the same 100/900 pairing as the other status badges).
- **An unlabelled control**: the attachment input was focusable but had no name; it is now
  hidden behind the "Attach files" button that opens it.
