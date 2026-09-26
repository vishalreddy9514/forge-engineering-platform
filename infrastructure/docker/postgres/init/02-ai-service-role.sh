#!/bin/sh
# Login user for the AI service (local development only).
#
# The Prisma migration creates the NOLOGIN group role `forge_ai` and grants it access to the
# RAG tables only (ADR-0004). This script, run once when the data volume is created, adds a
# login user that inherits those grants. Its password comes from the environment, so none is
# committed; in AWS the equivalent user is created by Terraform with a generated password.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v ai_password="${AI_DB_PASSWORD:?AI_DB_PASSWORD must be set}" <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forge_ai') THEN
        CREATE ROLE forge_ai NOLOGIN;
    END IF;
END
$$;
CREATE ROLE forge_ai_service LOGIN PASSWORD :'ai_password' IN ROLE forge_ai;
SQL
