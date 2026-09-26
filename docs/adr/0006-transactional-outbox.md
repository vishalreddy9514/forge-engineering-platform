# ADR-0006: Transactional outbox for side effects

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

Many writes trigger asynchronous work: notifications, re-indexing for RAG, audit fan-out.
Enqueuing to Redis directly from a service after the DB write is a dual write. A crash between
the two loses the job, and enqueueing inside the transaction publishes a job for data that may
roll back.

## Decision

Services insert an `outbox_events` row in the **same transaction** as the domain change. A relay
in the worker process claims unpublished rows with `FOR UPDATE SKIP LOCKED`, adds BullMQ jobs
with **deterministic job IDs**, and marks the rows published. Postgres `LISTEN/NOTIFY` wakes the
relay for low latency, and a 500 ms poll is the fallback. Published rows are pruned after 7 days.

## Alternatives considered

- **Enqueue after commit, no outbox.** Simple, but loses events on crash. For notifications that
  might be tolerable; for search index consistency it is not.
- **Change data capture (Debezium).** The right tool at scale, but it needs Kafka Connect
  infrastructure that is far out of proportion here.

## Consequences

- ➕ Consistent: an event exists if and only if its change was committed. Delivery is
  at-least-once, and processors are idempotent.
- ➖ An extra table and a relay loop, with up to ~500 ms of added latency in the worst case.
  Irrelevant for these use cases.
