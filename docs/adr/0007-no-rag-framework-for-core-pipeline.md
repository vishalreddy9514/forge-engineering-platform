# ADR-0007: Hand-written RAG pipeline with hybrid retrieval in pgvector

- **Status:** Accepted
- **Date:** 2026-09-26

## Context

The brief suggests LangChain or LlamaIndex "only where genuinely useful". The RAG system must
index five source types, filter by project permissions, cite sources and be evaluated.

## Decision

- Write the pipeline directly: source-aware chunkers, a batched embedder, SQL against pgvector,
  reciprocal rank fusion, prompt assembly and citation mapping. Each step is a small, typed,
  unit-tested function.
- Store vectors in **pgvector in the main Postgres** with an HNSW index (cosine), alongside a
  `tsvector` column for keyword retrieval, and combine the two with **reciprocal rank fusion**.
- Model access goes through a small provider interface with an OpenAI implementation and a
  deterministic fake for tests.
- A retrieval evaluation set runs in CI.

## Alternatives considered

- **LangChain / LlamaIndex for the whole pipeline.** Their abstractions (retrievers, chains,
  vector-store wrappers) make permission filters and hybrid SQL harder to express precisely and
  hide the step that matters most when debugging, the actual query. Version churn is also high.
  They may still be used for an individual utility, such as a Markdown header splitter, if it
  saves real effort.
- **Dedicated vector DB (Pinecone, Qdrant, OpenSearch).** Another service to run and pay for, and
  the permission filter would depend on metadata being copied there correctly. pgvector with HNSW
  comfortably handles this corpus size (roughly 10⁵–10⁶ chunks).

## Consequences

- ➕ Every stage can be inspected and tested, and the permission filter is plain SQL.
- ➕ Chunks can be deleted in the same transaction as their source row.
- ➖ Features such as query rewriting and rerankers must be added by hand when needed. That is
  deliberate: each one is added with an eval result that justifies it.
