# Forge: AI-Assisted Engineering Issue & Project Management

A lightweight Jira + GitHub engineering assistant. Teams manage projects, issues and sprints,
connect GitHub repositories, and use AI where it helps: drafting well-formed issues, summarising
long threads, detecting duplicates, reviewing pull requests and answering questions over project
history with cited sources.

AI is a feature of the product, not the product. Every core workflow works with the AI service
switched off.

> **Status: Phase 2 of 20 (repository structure and configuration).** The monorepo, tooling,
> CI and local infrastructure are in place, and the three services boot and talk to each other.
> Domain features start in Phase 3. Each phase lands with tests, CI and updated docs.

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
  api/          NestJS REST API (Prisma from Phase 3; a BullMQ worker entrypoint from Phase 6)
  ai-service/   FastAPI service for embeddings, RAG and LLM features (Python, uv)
packages/
  types/        Zod schemas + TypeScript types shared by web and api
  ui/           shadcn/ui components and design tokens
  config/       Shared TypeScript, ESLint and Prettier presets
infrastructure/
  docker/       Postgres init script (extensions, test database)
docs/           Requirements, architecture, ADRs
```

## Local development

**Prerequisites:** Node.js 22 (`.nvmrc`), pnpm 10 (`corepack enable`), Docker, and
[uv](https://docs.astral.sh/uv/) for the Python service.

```bash
cp .env.example .env
pnpm install
(cd apps/ai-service && uv sync)
pnpm infra:up        # Postgres (pgvector), Redis and Mailpit, waits until healthy
pnpm dev             # web :3000, api :4000, ai-service :8000, all with hot reload
```

Open http://localhost:3000. The system status card calls the API through the same-origin
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
| `pnpm infra:down`                            | Stop the containers (add `-v` to `docker compose down` to wipe data) |

## Documentation

- [Requirements](docs/requirements.md): problem statement, roles and permission matrix,
  functional and non-functional requirements, delivery plan
- [Architecture](docs/architecture.md): system and container diagrams, module structure,
  async and outbox design, security and threat model, AI/RAG design, AWS deployment,
  observability, API conventions
- [Architecture decision records](docs/adr): the significant choices and the alternatives rejected

## Licence

[MIT](LICENSE)
