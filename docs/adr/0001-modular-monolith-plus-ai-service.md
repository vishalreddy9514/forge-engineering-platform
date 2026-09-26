# ADR-0001: Modular monolith plus a separate AI service

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Forge has a tightly coupled core domain (projects, issues, sprints, permissions) and an AI
capability with very different characteristics: Python-first ecosystem, latency in seconds,
per-call cost, and external provider outages. The team is one developer, and the system must be
runnable locally with one command and cheap to host.

## Decision

- The core domain is a **modular monolith** in NestJS (`apps/api`), with module boundaries
  enforced by lint rules. It has two entrypoints: `main.ts` (HTTP) and `worker.ts` (BullMQ
  consumers), deployed as separate processes from the same image.
- AI runs in a **separate FastAPI service** (`apps/ai-service`) that is only reachable on the
  internal network.

## Alternatives considered

- **Microservices per domain (issues-service, sprint-service, …).** Rejected. Issue ↔ sprint ↔
  project operations need transactions across all three (e.g. completing a sprint moves issues).
  Splitting would mean sagas, duplicated authorisation and N× the deployment surface, with no
  scaling benefit at this size.
- **AI inside the NestJS app (OpenAI Node SDK).** Viable, but it loses the Python tooling for
  evaluation and tokenisation, and couples an unreliable, slow dependency to the request-serving
  process.
- **Workers inside the API process.** Rejected. A CPU-heavy or slow job would add latency to HTTP
  requests, and the two can't be scaled independently.

## Consequences

- ➕ One transaction boundary for the domain; simple local development; clear AI failure isolation (NFR-4).
- ➕ The API and worker share code and types but scale independently.
- ➖ Two languages to maintain (TypeScript and Python), with a contract between them. Mitigated by
  an OpenAPI spec generated from FastAPI and a contract test in CI.
- ➖ A module boundary is only as strong as its lint rule. If a module needed to be extracted
  later, its events and service interface are already the seam.
