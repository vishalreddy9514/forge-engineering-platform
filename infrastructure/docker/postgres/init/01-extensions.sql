-- Runs once, when the Postgres data volume is first created.
-- Schema, tables and application roles are owned by Prisma migrations (ADR-0004); this file
-- only prepares what migrations cannot: extensions that need superuser, and the test database.

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: embeddings for RAG (architecture §7)
CREATE EXTENSION IF NOT EXISTS pg_trgm;  -- trigram indexes for fuzzy keyword search
CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive emails

-- Separate database for integration tests so they never touch development data.
CREATE DATABASE forge_test;
\connect forge_test
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
