# Requirements

> **Phase 1 deliverable.** This is the contract the later phases build against. When the
> implementation departs from it, the departure is recorded as an ADR in [`adr/`](adr), not
> silently changed here.

Working name: **Forge**, an AI-assisted engineering issue and project management platform.

## 1. Problem statement

Small engineering teams split their work across an issue tracker (Jira, Linear), a code host
(GitHub) and a wiki. Three problems follow:

1. **Poor issue quality.** Issues are often one-line reports ("users can't reset password") with
   no acceptance criteria, no priority rationale and no labels. Triage time goes on rewriting them.
2. **Lost context.** The explanation of why something broke is spread over issue comments, PR
   descriptions, commit messages and design docs. Answering "what caused the payment incident?"
   means searching four tools by hand.
3. **Duplicate work.** Nobody notices that a new bug is the same as one closed three sprints ago.

Forge is a lightweight issue tracker with GitHub integration. AI features are built on top of a
normal, fully working product, and each one targets one of the three problems above:

| Problem            | Core feature (works without AI)                            | AI feature on top                                 |
| ------------------ | ---------------------------------------------------------- | ------------------------------------------------- |
| Poor issue quality | Structured issue model: priority, labels, sprint, due date | Draft a complete issue from one sentence          |
| Lost context       | GitHub sync, docs, comments and history all in one place   | RAG assistant that answers with source references |
| Duplicate work     | Keyword search with filters                                | Related-issue detection with embeddings           |

**Design rule:** if the AI service is down or no API key is set, every core workflow still works.
AI endpoints return `503` with a clear message. They never break issue CRUD.

## 2. Users and roles

Roles are **per project**, plus one global **Admin** flag. A person can be a Project Manager on
one project and a Viewer on another, which is how real teams work.

| Role                | Scope   | Who            | Summary                                                         |
| ------------------- | ------- | -------------- | --------------------------------------------------------------- |
| **Admin**           | Global  | Platform owner | Manages users, all projects, GitHub App installs and audit logs |
| **Project Manager** | Project | Tech lead / PM | Project settings, members, sprints and any issue in the project |
| **Developer**       | Project | Engineer       | Creates and updates issues, comments, uses AI features          |
| **Viewer**          | Project | Stakeholder    | Read-only, including read-only AI chat over the project         |

### Permission matrix

`✓` allowed · `own` only resources they created · `–` denied. Admin can do everything.

| Action                                     | PM  | Developer | Viewer |
| ------------------------------------------ | --- | --------- | ------ |
| View project, issues, sprints, dashboard   | ✓   | ✓         | ✓      |
| Update project settings / archive project  | ✓   | –         | –      |
| Add / remove members, change member roles  | ✓   | –         | –      |
| Create issue                               | ✓   | ✓         | –      |
| Update issue fields / transition status    | ✓   | ✓         | –      |
| Delete issue                               | ✓   | –         | –      |
| Comment                                    | ✓   | ✓         | –      |
| Edit / delete comment                      | ✓   | own       | –      |
| Upload attachment                          | ✓   | ✓         | –      |
| Create / start / complete sprint           | ✓   | –         | –      |
| Link GitHub repository to project          | ✓   | –         | –      |
| Trigger GitHub re-sync                     | ✓   | ✓         | –      |
| AI: draft issue, summarise, related issues | ✓   | ✓         | –      |
| AI: chat / semantic search                 | ✓   | ✓         | ✓      |
| AI: request PR review                      | ✓   | ✓         | –      |
| Upload / edit engineering documents        | ✓   | ✓         | –      |

Enforcement happens in the API, never only in the UI (see [architecture §6](architecture.md#6-security-architecture)).
Resources in a project the caller cannot access return **404, not 403**, so the API does not
reveal which project IDs exist.

## 3. Functional requirements

Priorities use MoSCoW. **Must** is the portfolio-critical path. **Should** is built unless a
phase overruns. **Could** goes to "Future improvements" if time runs out.

### FR-1 Authentication — Must

- FR-1.1 Register with email, display name and password. Passwords need at least 12 characters and are checked against a breached-password list (k-anonymity HIBP range API, fails open).
- FR-1.2 Log in and receive a short-lived access token (JWT, 15 min) and a rotating refresh token (httpOnly cookie, 7 days).
- FR-1.3 Refresh with rotation. Reusing an already-rotated refresh token revokes the whole token family.
- FR-1.4 Logout revokes the current refresh token. "Log out everywhere" revokes all of them.
- FR-1.5 Password reset: single-use token, stored hashed, 30 min expiry. The same response is returned whether or not the email exists.
- FR-1.6 View and update your profile (name, avatar, password change that requires the current password).
- FR-1.7 Lock out after repeated failed logins (progressive delay per account and per IP).

### FR-2 Users, teams and RBAC — Must

- FR-2.1 Admin can list, deactivate and reactivate users, and grant or revoke Admin.
- FR-2.2 Project members have one project role: PM, Developer or Viewer.
- FR-2.3 Teams (Should): named groups of users that can be added to a project in one step.
- FR-2.4 The first Admin is created from environment variables on first boot. There is no default password.

### FR-3 Project management — Must

- FR-3.1 Create a project with a name, a unique **key** (2–10 uppercase letters, e.g. `PAY`) and a description. The creator becomes PM.
- FR-3.2 Update the name, description and settings: default assignee, allowed labels, workflow statuses (fixed set in v1).
- FR-3.3 Archive (soft) and restore. Hard delete is Admin-only and cascades.
- FR-3.4 Manage members and their roles.

### FR-4 Issue management — Must

- FR-4.1 Issues get a human key `PAY-123`, allocated per project inside a transaction, with no gaps from concurrent creates.
- FR-4.2 Fields: title, description (Markdown), type (bug / feature / task / chore), status, priority, assignee, reporter, labels, sprint, due date, story points, timestamps.
- FR-4.3 Statuses: `BACKLOG → TODO → IN_PROGRESS → IN_REVIEW → DONE`, plus `CANCELLED`. Transitions are validated by a state machine.
- FR-4.4 Priorities: `CRITICAL, HIGH, MEDIUM, LOW`.
- FR-4.5 Comments in Markdown, rendered and sanitised. Edit and delete are recorded in history.
- FR-4.6 Attachments: upload straight to object storage through pre-signed URLs, with a size limit (10 MB) and a content-type allow-list.
- FR-4.7 **Issue history**: every field change is stored as an event (who, when, field, old value, new value) and shown as a timeline.
- FR-4.8 Optimistic concurrency: updates carry a `version`. A stale update gets `409 Conflict`.
- FR-4.9 List issues with filters (status, priority, assignee, label, sprint, type, text), sorting and cursor pagination.

### FR-5 Sprint management — Must

- FR-5.1 Create a sprint with a name, goal, start and end dates. Only one sprint per project can be `ACTIVE`, enforced by a partial unique index.
- FR-5.2 Start a sprint (`PLANNED → ACTIVE`) and complete it (`ACTIVE → COMPLETED`). On completion, unfinished issues move to the backlog or to a chosen next sprint.
- FR-5.3 Add and remove issues from a sprint.
- FR-5.4 **Velocity**: completed story points per sprint over the last N sprints.
- FR-5.5 **Burndown**: remaining points per day, built from issue history events rather than a nightly snapshot.

### FR-6 GitHub integration — Must

- FR-6.1 Connect a GitHub account or organisation by installing the Forge **GitHub App**.
- FR-6.2 Link one or more repositories to a project.
- FR-6.3 Sync repositories, pull requests, commits, contributors and (read-only) GitHub issues. Initial sync is a background job. Later updates come from **webhooks** (signature-verified), with a scheduled reconciliation job as a fallback.
- FR-6.4 Automatic links: a PR or commit mentioning `PAY-123` is linked to that issue and shown on it.
- FR-6.5 Rate-limit aware: respects `X-RateLimit-Remaining` and backs off.

### FR-7 AI issue assistant — Must

- FR-7.1 **Draft generation**: from free text, produce a title, description, acceptance criteria (Given/When/Then), a suggested priority with a one-line rationale, labels chosen from the project's existing labels, and a technical area. The output is schema-validated. The user reviews and edits it before saving; **AI never creates issues on its own**.
- FR-7.2 **Summarisation**: summarise an issue's description and comment thread into a TL;DR, key decisions, open questions and next steps. Cached against a hash of the thread content.
- FR-7.3 **Related issues**: top-k similar issues in the same project by embedding similarity, with a score and a threshold. Shown on the issue page and while drafting to prevent duplicates.
- FR-7.4 **Assistant chat**: natural-language questions over project data, answered with retrieval-augmented generation (FR-8) and **cited sources**. Structured questions ("bugs fixed in the last sprint") use a tool call to the relational API instead of vector search.

### FR-8 RAG system — Must

- FR-8.1 Sources: issues, comments, PRs, commits and engineering documents (Markdown or plain text uploads).
- FR-8.2 Pipeline: ingest → normalise → chunk → embed → store in pgvector → retrieve (hybrid) → rerank → generate → cite.
- FR-8.3 Incremental indexing: a change to a source re-indexes only that source. Content hashes skip unchanged chunks.
- FR-8.4 **Permission-aware retrieval**: every chunk carries `project_id`, and retrieval is always filtered by the caller's accessible projects.
- FR-8.5 Every answer cites the sources it used, as links back to the issue, PR, commit or document section. The prompt tells the model to say "I don't know" when the context is insufficient.
- FR-8.6 An offline evaluation set (question, expected source) measures retrieval hit-rate@k in CI.

### FR-9 AI code review assistant — Should

- FR-9.1 For a linked PR, fetch metadata and the diff per file. Skip binary, generated and lockfiles, and cap the total token budget.
- FR-9.2 Produce findings per file (line, severity, category, explanation, suggestion), an overall summary and suggested missing tests.
- FR-9.3 Runs as a background job. Results are stored and shown on the PR page with a banner: _"AI-generated suggestions. This does not replace human code review."_
- FR-9.4 Optional (Could): post the summary as a GitHub PR comment, only when the user explicitly clicks it.

### FR-10 Dashboard — Must

Open issues; issues by priority and by status; active sprint progress and burndown; developer
workload (open points per assignee); PR activity (opened / merged per week); median and p90
issue resolution time; AI usage (requests, tokens, estimated cost per feature per week).

### FR-11 Search — Must

- FR-11.1 Keyword search: Postgres full-text search (`tsvector`, weighted title > description > comments) with prefix matching.
- FR-11.2 Semantic search over the same corpus through the RAG retriever.
- FR-11.3 Filters, sorting and cursor pagination on both. Both are scoped to the caller's projects.

### FR-12 Notifications — Must

- FR-12.1 Events: issue assigned, comment added, @mention, sprint started or completed, PR opened on a linked repo, AI job completed or failed.
- FR-12.2 In-app notification centre (unread count, mark read). Delivered by background workers.
- FR-12.3 Email for assignment and mentions (Should), through SMTP (Mailpit locally, SES in AWS).
- FR-12.4 Real-time push to the browser via Server-Sent Events (Could; polling every 30 s is the fallback).

### FR-13 Audit log — Must

Security-relevant and administrative actions are written to an append-only `audit_logs` table:
login success and failure, role changes, member changes, project archive and delete, GitHub
connect, AI review requests. Each entry has the actor, IP, user agent and request ID. Admins can view it.

## 4. Non-functional requirements

| ID     | Category        | Requirement                                                                                                                                | How it is verified                           |
| ------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| NFR-1  | Performance     | CRUD endpoints p95 < 250 ms at 50 RPS on the dev stack                                                                                     | k6 script in Phase 19                        |
| NFR-2  | Performance     | No request thread waits on LLM work except streaming chat. Everything else is queued and returns `202`                                     | Architecture review, integration tests       |
| NFR-3  | Performance     | Issue list stays at p95 < 150 ms with 100k issues                                                                                          | Seeded load test, `EXPLAIN ANALYZE` in docs  |
| NFR-4  | Availability    | Core features work with the AI service down (degraded mode)                                                                                | Integration test with the AI service stopped |
| NFR-5  | Reliability     | Jobs are idempotent, retried with exponential backoff and dead-lettered after N attempts                                                   | Unit tests on processors                     |
| NFR-6  | Security        | OWASP ASVS L1 controls; OWASP Top 10 and OWASP LLM Top 10 addressed (see architecture §6)                                                  | Security checklist, ZAP baseline scan in CI  |
| NFR-7  | Security        | No secrets in the repo or images. Secrets come from env locally and SSM Parameter Store in AWS                                             | gitleaks in CI                               |
| NFR-8  | Observability   | JSON logs with a request ID propagated across web → api → worker → ai-service; RED metrics per service; `/health/live` and `/health/ready` | Grafana dashboard, tests                     |
| NFR-9  | Maintainability | TypeScript strict mode; ESLint and Prettier; Ruff and mypy; shared types between web and api                                               | CI gates                                     |
| NFR-10 | Testability     | Coverage ≥ 80 % on domain services; integration tests against real Postgres and Redis (Testcontainers); E2E for critical journeys          | CI coverage report                           |
| NFR-11 | Cost            | AWS dev environment ≤ ~$75/month when running and ≈ $5/month when scaled to zero                                                           | Cost table in deployment.md                  |
| NFR-12 | Cost (AI)       | Per-user daily token budget; every LLM call records tokens and estimated cost                                                              | `ai_usage` metrics, dashboard                |
| NFR-13 | Accessibility   | Frontend meets WCAG 2.1 AA on core pages                                                                                                   | axe checks in Playwright                     |
| NFR-14 | Portability     | Whole stack runs locally with `pnpm install && docker compose up`                                                                          | README walkthrough                           |

## 5. Out of scope (v1)

These are stated so reviewers can see they were decided, not forgotten.

- Custom per-project workflows. v1 uses a fixed status set.
- Multi-tenancy / organisations as a billing boundary. v1 is single-organisation.
- SSO / OAuth login (Future: "Sign in with GitHub").
- Mobile apps.
- Fine-tuning models. Prompting, retrieval and evaluation give more value per hour.
- Kubernetes. ECS Fargate is enough at this scale (see ADR-0005).

## 6. Delivery plan

Each phase ends with passing CI, updated docs and a tagged commit.

| Phase | Output                                               | Key acceptance check                                   |
| ----- | ---------------------------------------------------- | ------------------------------------------------------ |
| 1     | Requirements, architecture, ADRs (this)              | Reviewed and agreed                                    |
| 2     | Monorepo, tooling, config, Compose skeleton, CI lint | `pnpm lint && pnpm typecheck` green on an empty app    |
| 3     | Prisma schema, migrations, seed                      | Migration applies on a clean DB; constraint tests pass |
| 4     | Auth and RBAC                                        | Supertest suite covers the permission matrix           |
| 5–7   | Projects, issues, sprints                            | Integration tests; burndown computed from events       |
| 8     | GitHub App, sync, webhooks                           | Webhook signature test; recorded-fixture sync tests    |
| 9–11  | AI service, RAG, code review                         | Pytest; retrieval eval hit-rate@5 ≥ 0.8 on seed set    |
| 12    | Dashboard                                            | Aggregates tested against seeded data                  |
| 13    | Test hardening, Playwright                           | Critical journeys green in CI                          |
| 14–15 | Docker, CI/CD                                        | Images built and pushed on main                        |
| 16    | AWS with Terraform                                   | `terraform apply` → live URL; teardown documented      |
| 17–19 | Observability, security hardening, performance       | Dashboards; ZAP scan; k6 results in docs               |
| 20    | README, screenshots, CV bullets                      | Ready to share                                         |
