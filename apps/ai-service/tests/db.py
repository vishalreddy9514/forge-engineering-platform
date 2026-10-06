"""A throwaway Postgres database with the real schema, for retrieval tests and the eval.

The schema comes from the API's Prisma migrations (the single migration owner, ADR-0004),
applied in order, so these tests run against exactly what production runs. The service side
connects as a login in the `forge_ai` role, so a query that needs more than the RAG tables fails
here the same way it would in production.

TEST_DATABASE_ADMIN_URL points at a server where that user may create databases (the compose
Postgres superuser locally, the service container in CI). Without it the database tests are
skipped, unless REQUIRE_DB_TESTS=1, which CI sets so that they can never silently not run.
"""

import hashlib
import json
import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import psycopg
import pytest
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

MIGRATIONS = Path(__file__).resolve().parents[2] / "api" / "prisma" / "migrations"
SERVICE_ROLE = "forge_ai_pytest"
SERVICE_PASSWORD = "pytest-only-password"  # throwaway role on a test server


def admin_url() -> str | None:
    url = os.environ.get("TEST_DATABASE_ADMIN_URL")
    if not url and os.environ.get("REQUIRE_DB_TESTS") == "1":
        pytest.fail("REQUIRE_DB_TESTS=1 but TEST_DATABASE_ADMIN_URL is not set")
    return url


def with_database(url: str, dbname: str, **overrides: str) -> str:
    params = conninfo_to_dict(url)
    params.update(dbname=dbname, **overrides)
    return make_conninfo(**params)  # type: ignore[arg-type]


@dataclass(frozen=True)
class ScratchDatabase:
    admin_url: str
    service_url: str
    name: str


def create_database(server_url: str) -> ScratchDatabase:
    name = f"forge_ai_test_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(server_url, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    admin = with_database(server_url, name)
    with psycopg.connect(admin, autocommit=True) as conn:
        # Prisma creates its history table before the first migration, and migrations may refer
        # to it (the runtime role's REVOKE), so it must exist when they are applied directly.
        conn.execute('CREATE TABLE "_prisma_migrations" (id varchar(36) PRIMARY KEY)')
        for migration in sorted(MIGRATIONS.glob("*/migration.sql")):
            conn.execute(migration.read_text())
        # Roles are per server, so the login may already exist from an earlier run.
        exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (SERVICE_ROLE,))
        if exists.fetchone() is None:
            conn.execute(
                sql.SQL("CREATE ROLE {} LOGIN PASSWORD {} IN ROLE forge_ai").format(
                    sql.Identifier(SERVICE_ROLE), sql.Literal(SERVICE_PASSWORD)
                )
            )
    service = with_database(server_url, name, user=SERVICE_ROLE, password=SERVICE_PASSWORD)
    return ScratchDatabase(admin, service, name)


def drop_database(server_url: str, database: ScratchDatabase) -> None:
    with psycopg.connect(server_url, autocommit=True) as conn:
        conn.execute(
            sql.SQL("DROP DATABASE IF EXISTS {} WITH (FORCE)").format(sql.Identifier(database.name))
        )


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


class Fixtures:
    """Writes the rows the API owns (users, projects, documents), as the API would."""

    def __init__(self, admin: psycopg.Connection[Any]) -> None:
        self.conn = admin
        self.user_id = uuid.uuid4()
        admin.execute(
            """INSERT INTO users (id, email, display_name, password_hash, updated_at)
               VALUES (%s, %s, 'Test User', 'x', now())""",
            (self.user_id, f"{self.user_id}@example.test"),
        )

    def project(self, key: str | None = None) -> uuid.UUID:
        project_id = uuid.uuid4()
        key = key or "P" + uuid.uuid4().hex[:6].upper()
        self.conn.execute(
            """INSERT INTO projects (id, key, name, created_by_id, updated_at)
               VALUES (%s, %s, %s, %s, now())""",
            (project_id, key, f"Project {key}", self.user_id),
        )
        return project_id

    def document(
        self,
        project_id: uuid.UUID,
        title: str,
        content: str,
        source_type: str = "ISSUE",
        source_id: uuid.UUID | None = None,
        url: str | None = None,
    ) -> tuple[uuid.UUID, uuid.UUID | None]:
        document_id = uuid.uuid4()
        if source_type != "UPLOAD":
            source_id = source_id or uuid.uuid4()
        self.conn.execute(
            """INSERT INTO documents (id, project_id, source_type, source_id, title, content, url,
                                      content_hash, metadata, updated_at)
               VALUES (%s, %s, %s::document_source_type, %s, %s, %s, %s, %s, %s, now())""",
            (
                document_id,
                project_id,
                source_type,
                source_id,
                title,
                content,
                url or f"/documents/{document_id}",
                sha256(title + "\n" + content),
                json.dumps({}),
            ),
        )
        return document_id, source_id

    def update_document(self, document_id: uuid.UUID, title: str, content: str) -> None:
        self.conn.execute(
            """UPDATE documents SET title = %s, content = %s, content_hash = %s, updated_at = now()
               WHERE id = %s""",
            (title, content, sha256(title + "\n" + content), document_id),
        )

    def chunks(self, document_id: uuid.UUID) -> list[dict[str, Any]]:
        cur = self.conn.execute(
            """SELECT chunk_index, content, heading_path, content_hash, embedding_model,
                      embedding::text AS embedding
               FROM document_chunks WHERE document_id = %s ORDER BY chunk_index""",
            (document_id,),
        )
        columns = [c.name for c in cur.description or []]
        return [dict(zip(columns, row, strict=True)) for row in cur.fetchall()]
