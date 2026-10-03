# Forge: AI-Assisted Engineering Issue & Project Management

A lightweight Jira + GitHub engineering assistant. Teams manage projects, issues and sprints,
connect GitHub repositories, and use AI where it helps: drafting well-formed issues, summarising
long threads, detecting duplicates, reviewing pull requests and answering questions over project
history with cited sources.

AI is a feature of the product, not the product. Every core workflow works with the AI service
switched off.

> **Status: Phase 17 of 20 (observability).** Every service exports Prometheus metrics
> (requests by route, jobs and queues, every model call's latency, tokens and cost), one request
> ID follows a request from the proxy through the queue to the AI service, errors can go to
> Sentry scrubbed of personal data, and an `observability` compose profile adds Prometheus, a
> provisioned Grafana dashboard and tested alert rules ([observability](docs/observability.md)).
> Before that: AWS with Terraform, deployed through GitHub OIDC with no secret in Terraform
> state (Phase 16, [deployment](docs/deployment.md)), CI/CD with
> signed, scanned images (Phase 15), Docker (Phase 14), test hardening with Playwright and axe
> (Phase 13), the dashboard (Phase 12), AI code review (Phase 11), RAG search and cited chat
> (Phase 10), the AI assistant (Phase 9), the GitHub App integration (Phase 8), sprints
> (Phase 7), issues and notifications (Phase 6), projects (Phase 5), authentication and RBAC
> (Phase 4), the schema (Phase 3) and the monorepo (Phase 2).

## Stack

| Layer          | Technology                                                                              |
| -------------- | --------------------------------------------------------------------------------------- |
| Frontend       | Next.js, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, React Hook Form, Zod      |
| Backend        | NestJS, PostgreSQL 16, Prisma, Redis, BullMQ                                            |
| AI service     | Python, FastAPI, OpenAI API, pgvector, hybrid RAG                                       |
| Infrastructure | Docker Compose, Terraform, AWS (ECS Fargate, RDS, ElastiCache, S3, ALB), GitHub Actions |
| Observability  | Structured JSON logs, Prometheus, Grafana, Sentry, health checks                        |
| Testing        | Jest, Supertest, Pytest, Playwright                                                     |

## Repository layout

```
apps/
  web/          Next.js app (App Router, Tailwind, TanStack Query)
  api/          NestJS REST API, Prisma schema + migrations + seed, plus a BullMQ worker
  ai-service/   FastAPI service for embeddings, RAG and LLM features (Python, uv)
packages/
  types/        Zod schemas + TypeScript types shared by web and api
  ui/           shadcn/ui components and design tokens
  config/       Shared TypeScript, ESLint and Prettier presets
infrastructure/
  docker/       Nginx config, Postgres init scripts, SeaweedFS config, stack secrets generator
  terraform/    AWS: bootstrap, modules (network, data, service, stack) and environments
e2e/            Playwright journeys and axe accessibility checks against the built stack
observability/  Prometheus config, alert rules and their tests, the Grafana dashboard
docs/           Requirements, architecture, ADRs, testing
```

## Local development

**Prerequisites:** Node.js 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker, and
[uv](https://docs.astral.sh/uv/) for the Python service.

```bash
cp .env.example .env
pnpm install
(cd apps/ai-service && uv sync)
pnpm infra:up        # Postgres (pgvector), Redis, Mailpit and SeaweedFS (S3), waits until healthy
pnpm --filter @forge/api db:deploy   # apply database migrations
pnpm --filter @forge/api db:seed     # demo users, projects, sprints and issues
pnpm dev             # web :3000, api :4000 (+ worker), ai-service :8000, hot reload
```

Sign in at http://localhost:3000 with a seeded account: `priya@forge.local` (project manager),
`sam@forge.local` (developer), `jordan@forge.local` (viewer on PAY) or `admin@forge.local`, all
with the password `forge-demo-password`. Password-reset and assignment emails land in Mailpit at
http://localhost:8025. Attachments upload straight from the browser to the local S3-compatible
store on port 8333 ([ADR-0011](docs/adr/0011-local-object-storage-seaweedfs.md)).

The home page's system status card calls the API through the same-origin
`/api` rewrite and shows the live readiness of each dependency. Stop Redis
(`docker compose stop redis`) and it turns red within 15 seconds.

| URL                                       | What                                                          |
| ----------------------------------------- | ------------------------------------------------------------- |
| http://localhost:3000                     | Web app                                                       |
| http://localhost:4000/api/docs            | Swagger UI (OpenAPI JSON at `/api/docs/openapi.json`)         |
| http://localhost:4000/api/v1/health/ready | API readiness (`/health/live` for liveness)                   |
| http://localhost:8000/docs                | AI service OpenAPI (internal service; disabled in production) |
| http://localhost:8025                     | Mailpit, which catches all outgoing email                     |

### Commands

All commands run from the repository root; Turborepo runs them across every package,
including the Python service, in dependency order and caches the results.

| Command                                      | Does                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------- |
| `pnpm check`                                 | Lint, typecheck and test everything (what CI runs)                   |
| `pnpm lint` / `pnpm typecheck` / `pnpm test` | One kind of check across all packages                                |
| `pnpm build`                                 | Production builds                                                    |
| `pnpm format`                                | Prettier over the repository (Ruff formats Python)                   |
| `pnpm --filter @forge/api test:e2e`          | Only the API's HTTP-level tests                                      |
| `pnpm --filter @forge/api test:integration`  | Database tests against a throwaway Postgres (needs Docker)           |
| `pnpm --filter @forge/api test:coverage`     | Unit and integration tests with the domain-service coverage gate     |
| `pnpm e2e`                                   | Browser journeys and accessibility checks (see docs/testing.md)      |
| `pnpm --filter @forge/api db:migrate`        | Create and apply a migration after editing `schema.prisma`           |
| `pnpm --filter @forge/api db:studio`         | Browse the database in Prisma Studio                                 |
| `pnpm infra:down`                            | Stop the containers (add `-v` to `docker compose down` to wipe data) |

## Documentation

- [Requirements](docs/requirements.md): problem statement, roles and permission matrix,
  functional and non-functional requirements, delivery plan
- [Architecture](docs/architecture.md): system and container diagrams, module structure,
  async and outbox design, security and threat model, AI/RAG design, AWS deployment,
  observability, API conventions
- [API reference](docs/api.md): conventions, errors, and the auth, user and admin endpoints
- [Security](docs/security.md): implemented controls, how each is tested, and deliberate trade-offs
- [Testing](docs/testing.md): the test layers, the coverage gate, and the end-to-end journeys
- [Running in containers](docs/docker.md): the production images, the stack, and why it is built this way
- [CI/CD](docs/cicd.md): the workflows, image publishing, signing, and the vulnerability policy
- [Deploying to AWS](docs/deployment.md): setup, how a deploy works, secrets, TLS, hibernation,
  teardown and cost
- [Observability](docs/observability.md): request IDs, metrics, the dashboard, alerts and error
  reporting
- [GitHub App setup](docs/github-app-setup.md): registering the App, configuration, local webhooks
- [Database design](docs/database.md): ER diagrams, integrity rules, indexes, search, and
  why each constraint exists
- [Architecture decision records](docs/adr): the significant choices and the alternatives rejected

## Licence

[MIT](LICENSE)
