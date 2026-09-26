# Forge: AI-Assisted Engineering Issue & Project Management

A lightweight Jira + GitHub engineering assistant. Teams manage projects, issues and sprints,
connect GitHub repositories, and use AI where it helps: drafting well-formed issues, summarising
long threads, detecting duplicates, reviewing pull requests and answering questions over project
history with cited sources.

AI is a feature of the product, not the product. Every core workflow works with the AI service
switched off.

> **Status: Phase 1 of 20 (requirements and architecture).** No application code yet. The build
> proceeds phase by phase, and each phase lands with tests, CI and updated docs.

## Planned stack

| Layer | Technology |
|---|---|
| Frontend | Next.js, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, React Hook Form, Zod |
| Backend | NestJS, PostgreSQL 16, Prisma, Redis, BullMQ |
| AI service | Python, FastAPI, OpenAI API, pgvector, hybrid RAG |
| Infrastructure | Docker Compose, Terraform, AWS (ECS Fargate, RDS, ElastiCache, S3, ALB), GitHub Actions |
| Observability | Structured JSON logs, Prometheus, Grafana, Sentry, health checks |
| Testing | Jest, Supertest, Pytest, Playwright |

## Documentation

- [Requirements](docs/requirements.md): problem statement, roles and permission matrix,
  functional and non-functional requirements, delivery plan
- [Architecture](docs/architecture.md): system and container diagrams, module structure,
  async and outbox design, security and threat model, AI/RAG design, AWS deployment,
  observability, API conventions
- [Architecture decision records](docs/adr): the significant choices and the alternatives rejected
