# ADR-0004: Prisma is the single owner of the database schema

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Both `api` (TypeScript/Prisma) and `ai-service` (Python) need the database: the API for
everything, the AI service for `documents`, `document_chunks` (pgvector) and AI result tables.
Two migration tools on one database leads to drift and ordering bugs.

## Decision

- **All** DDL lives in Prisma migrations under `apps/api/prisma/migrations`, including the
  `CREATE EXTENSION vector`, the `vector(1536)` columns (modelled as `Unsupported("vector(1536)")`)
  and the HNSW indexes, written as raw SQL inside those migrations.
- `ai-service` has **no migration tool**. It uses psycopg 3 with explicit SQL and connects as
  the Postgres role `forge_ai`, which is granted `SELECT/INSERT/UPDATE/DELETE` only on
  `documents`, `document_chunks` and the `ai_*` tables. The grants are created in a migration.
- A CI job applies migrations to a fresh Postgres and runs the ai-service integration tests
  against it, so a schema change that breaks the AI service fails the PR.

## Alternatives considered

- **A separate database or schema for the AI service, owned by Alembic.** Cleaner ownership, but
  chunks must join to their sources' `project_id` for permission filtering and must be deleted
  when the source is deleted. Cross-database, that becomes eventual consistency for no gain.
- **The AI service reads core tables directly.** Rejected. The API would lose control of the
  authorisation boundary. Instead the API pushes normalised content to the AI service.

## Consequences

- ➕ One schema history and one place to review database changes.
- ➕ Least privilege: a compromised AI service cannot read users or tokens.
- ➖ The Python code has no generated models, so queries are hand-written SQL. They are few and
  covered by integration tests.
