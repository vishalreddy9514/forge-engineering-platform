# Forge on a CV

How to describe Forge in a CV, a cover letter or an interview, with the evidence behind each
claim. Everything here can be checked in this repository. Where something was not done, this
page says so.

## One-line summary

> Forge: a full-stack engineering issue tracker with GitHub integration and AI features
> (drafting, summaries, cited RAG answers, code review). TypeScript (Next.js, NestJS),
> Python (FastAPI), PostgreSQL with pgvector, Redis, Docker and Terraform for AWS. Built in 20
> reviewed phases with about 870 automated tests and measured performance, security and
> accessibility.

## Short project description (for a CV's projects section)

**Forge: AI-assisted engineering issue platform** (TypeScript, Python, PostgreSQL, AWS)

Designed and built a Jira-style tracker for engineering teams. It covers projects, issues,
sprints, a Kanban board, notifications and a dashboard, plus a GitHub App integration and AI
features that degrade gracefully when the model is unavailable. Delivered from written
requirements and architecture decision records through to production container images and
Terraform for AWS, with CI gates for tests, coverage, security scanning, accessibility and
load.

## CV bullets

Pick three to five. Each one is backed by the evidence linked after it.

- **Built a full-stack platform end to end.** Next.js web app, NestJS REST API with a BullMQ
  worker, and a FastAPI AI service, sharing one Zod contract package. Evidence:
  [architecture](architecture.md), [ADR-0001](adr/0001-modular-monolith-plus-ai-service.md).
- **Made the core flows correct under concurrency and failure.** Optimistic locking on issue
  edits. A transactional outbox, so notifications, emails and search indexing survive crashes.
  Database constraints for the rules that must never break. Evidence:
  [ADR-0006](adr/0006-transactional-outbox.md), [database design](database.md).
- **Shipped AI features with cost and failure limits.** Streamed issue drafts, background
  thread summaries, and pull request reviews cached per commit. Per-user budgets, a
  deterministic fake provider for tests, and every core workflow keeps working when the AI
  service is down. Evidence: [architecture](architecture.md),
  [ADR-0013](adr/0013-ai-provider-fake-and-contract-files.md),
  [ADR-0015](adr/0015-ai-review-stays-read-only-on-github.md).
- **Built a retrieval (RAG) pipeline without a framework.** Hybrid pgvector and full-text
  retrieval over issues, comments, documents and pull requests, with cited answers. CI fails
  if the retrieval evaluation's hit-rate@5 drops below 0.8. Evidence:
  [ADR-0007](adr/0007-no-rag-framework-for-core-pipeline.md),
  [ADR-0014](adr/0014-rag-indexing-ownership-and-chat-tool-round-trip.md),
  [testing](testing.md).
- **Integrated GitHub as a GitHub App.** Signed webhooks, installation tokens, rate-limit
  budgeting and a small REST client. Issue keys in branches, commits and pull requests link
  them to issues. Evidence: [ADR-0008](adr/0008-github-app-integration.md),
  [ADR-0012](adr/0012-github-rest-client-without-octokit.md),
  [setup guide](github-app-setup.md).
- **Load-tested to the requirements and fixed what the tests found.** k6 against 100,000
  issues: p95 of 14.5 ms for the CRUD mix at 50 req/s (target 250 ms) and 25 ms for the issue
  list (target 150 ms). Found an ORM count that scanned every comment (358 → 13 ms), a missing
  sort index and a search that returned the wrong first page, and added a CI regression gate.
  Evidence: [performance](performance.md).
- **Hardened security against OWASP ASVS Level 1.** 68 requirements met, with one documented
  gap. ES256 access tokens with refresh-token rotation and reuse detection, argon2id and
  breached-password checks, a nonce-based CSP, and a least-privilege database login. gitleaks
  and an OWASP ZAP baseline run on every pull request. Evidence: [ASVS](asvs.md),
  [security](security.md), [ADR-0010](adr/0010-es256-access-tokens-and-revocation.md),
  [ADR-0016](adr/0016-refresh-token-reuse-interval.md).
- **Automated quality gates in CI.** About 870 tests across unit, HTTP, integration
  (Testcontainers with real Postgres and Redis), Python and Playwright browser journeys with
  axe accessibility checks. Domain-service coverage is 95 % of lines, with a CI gate. Evidence:
  [testing](testing.md), [CI/CD](cicd.md).
- **Built the delivery pipeline.** Multi-stage, non-root production images, scanned by Trivy,
  signed, with an SBOM and provenance. Terraform for AWS (ECS Fargate, RDS, ElastiCache, S3,
  ALB) deployed through GitHub OIDC with no long-lived keys, and a deploy that verifies image
  attestations. Evidence: [docker](docker.md), [CI/CD](cicd.md), [deployment](deployment.md).
- **Made it operable.** One request ID from the load balancer through the API, the queue,
  the worker and the AI service. RED metrics, LLM latency and cost metrics, alert rules with unit
  tests, Grafana and CloudWatch dashboards, and error reporting with PII scrubbing. Evidence:
  [observability](observability.md).

## Talking points for an interview

Each is a decision with a trade-off. The ADR or document has the detail.

1. **Why a modular monolith plus one Python service, not microservices?** One team and one
   database. Python only where the AI ecosystem is, with a typed HTTP boundary between the
   two. ([ADR-0001](adr/0001-modular-monolith-plus-ai-service.md))
2. **How do you avoid losing a notification when the process crashes mid-request?** The
   transactional outbox: the side effect is a row written in the same transaction, and a relay
   publishes it. ([ADR-0006](adr/0006-transactional-outbox.md))
3. **How do you test AI features deterministically?** A fake provider behind the same
   interface, plus contract files shared by the TypeScript and Python tests.
   ([ADR-0013](adr/0013-ai-provider-fake-and-contract-files.md))
4. **Why no LangChain?** The pipeline is small: chunk, embed, hybrid retrieval, answer with
   citations. Owning it made it testable and the retrieval evaluation meaningful.
   ([ADR-0007](adr/0007-no-rag-framework-for-core-pipeline.md))
5. **What did load testing find that code review did not?** An innocent-looking `_count` in
   Prisma that grouped every comment in the database to show 50 rows.
   ([performance](performance.md#what-measuring-found))
6. **Why does the AI reviewer never comment on GitHub?** Trust and blast radius. Suggestions
   stay in Forge, where a human decides what to post.
   ([ADR-0015](adr/0015-ai-review-stays-read-only-on-github.md))
7. **How are secrets kept out of Terraform state?** They are generated by ephemeral resources
   and written only through write-only arguments, so neither the state nor a plan holds one.
   Tasks receive them by reference at start, and CI deploys through OIDC roles with no stored
   keys. ([deployment](deployment.md))

## What not to claim

Accuracy matters more than reach. These are the limits:

- **Not running in production, and no public demo.** The AWS stack is written, tested with
  `terraform test` against mocked providers, and scanned by Trivy. It has not been applied to
  a live account. Say "designed and tested for AWS", not "deployed to AWS".
- **No real users or production traffic.** Performance figures come from k6 on one machine
  against a generated dataset ([performance](performance.md#limits-and-what-is-not-measured)).
- **AI quality is measured on retrieval, not on answers.** The retrieval evaluation gates
  hit-rate@5. No evaluation measures the quality of a real model's answers, drafts or
  reviews.
- **Administrators have no second factor yet** (ASVS 4.3.1, [gaps](asvs.md#gaps)).
- **The screenshots use the fake AI provider**, so their AI text is deterministic
  placeholder output, not model output.
