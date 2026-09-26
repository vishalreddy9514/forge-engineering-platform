# Architecture Decision Records

Short records of significant decisions: the context, what was decided, what was rejected and
what it costs. Format: [Michael Nygard's ADR template](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions).
An ADR is never edited after it is accepted. A new ADR supersedes it.

| # | Title | Status |
|---|---|---|
| 0001 | [Modular monolith plus a separate AI service](0001-modular-monolith-plus-ai-service.md) | Accepted |
| 0002 | [Per-project roles with permissions defined in code](0002-per-project-rbac.md) | Accepted |
| 0003 | [Access and refresh token strategy](0003-auth-tokens.md) | Accepted |
| 0004 | [Prisma is the single owner of the database schema](0004-single-migration-owner.md) | Accepted |
| 0005 | [Cost-aware AWS deployment on ECS Fargate](0005-aws-ecs-fargate-cost-aware.md) | Accepted |
| 0006 | [Transactional outbox for side effects](0006-transactional-outbox.md) | Accepted |
| 0007 | [Hand-written RAG pipeline with hybrid retrieval in pgvector](0007-no-rag-framework-for-core-pipeline.md) | Accepted |
| 0008 | [GitHub App integration with webhooks and reconciliation](0008-github-app-integration.md) | Accepted |
