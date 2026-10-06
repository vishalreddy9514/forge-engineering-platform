-- The API and worker's runtime role (security hardening, Phase 18).
--
-- Until now they connected as the schema owner, so a SQL injection or a compromised task could
-- alter or drop tables, rewrite the audit log's triggers, or edit migration history. They now
-- connect as a login that inherits this NOLOGIN group role, which can read and write rows and
-- nothing else. Migrations keep running as the owner, in the separate migrate job.
--
-- The login (with its password) is created outside migrations by prisma/db-logins.ts, as the
-- AI service's is (ADR-0004).

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'forge_app') THEN
        CREATE ROLE forge_app NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO forge_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO forge_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO forge_app;

-- Tables that later migrations create get the same rights. (Default privileges apply to
-- objects created by the role that runs this, which is the role that runs every migration.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO forge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO forge_app;

-- The audit log is append-only for the application too, not only by trigger.
REVOKE UPDATE, DELETE ON "audit_logs" FROM forge_app;

-- Migration history is the migrate job's business.
REVOKE ALL ON "_prisma_migrations" FROM forge_app;
