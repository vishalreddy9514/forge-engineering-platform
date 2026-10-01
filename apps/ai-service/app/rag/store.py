"""pgvector reads and writes: SQL only, no ORM (architecture §7.1).

The service connects as `forge_ai_service`, a member of the `forge_ai` role, which can read and
write `documents` and `document_chunks` and nothing else (ADR-0004). Every retrieval statement
takes the caller's project IDs and filters on them in SQL (§7.4): the permission check does not
depend on the model, the prompt or any code after the query.

Vectors cross the wire as pgvector's text form ('[0.1,0.2,…]'), which avoids a NumPy dependency
and lets a stored embedding be reused byte for byte.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.rag.chunking import Chunk, SourceType

# Candidates each half of hybrid retrieval returns before fusion.
CANDIDATES = 40
# HNSW search breadth. With iterative scans (pgvector ≥ 0.8) a selective project filter keeps
# scanning the graph until enough rows pass it, instead of silently returning fewer.
EF_SEARCH = 100


def to_vector(values: Sequence[float]) -> str:
    return "[" + ",".join(f"{v:.7g}" for v in values) + "]"


@dataclass(frozen=True)
class DocumentRow:
    id: uuid.UUID
    project_id: uuid.UUID
    source_type: SourceType
    source_id: uuid.UUID | None
    title: str
    content: str
    content_hash: str


@dataclass(frozen=True)
class StoredChunk:
    index: int
    content_hash: str
    embedding_model: str


@dataclass(frozen=True)
class Hit:
    """One chunk returned by a retrieval query, with what a citation needs."""

    chunk_id: int
    document_id: uuid.UUID
    project_id: uuid.UUID
    source_type: SourceType
    source_id: uuid.UUID | None
    title: str
    url: str
    content: str
    heading_path: str | None
    score: float


class Store:
    def __init__(self, pool: AsyncConnectionPool[AsyncConnection[Any]]) -> None:
        self._pool = pool

    # ---------------------------------------------------------------- indexing

    async def load_document(self, document_id: uuid.UUID) -> DocumentRow | None:
        async with self._pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(
                """SELECT id, project_id, source_type::text AS source_type, source_id, title,
                          content, content_hash
                   FROM documents WHERE id = %s""",
                (document_id,),
            )
            row = await cur.fetchone()
        return DocumentRow(**row) if row else None

    async def stored_chunks(self, document_id: uuid.UUID) -> list[StoredChunk]:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                """SELECT chunk_index, content_hash, embedding_model FROM document_chunks
                   WHERE document_id = %s ORDER BY chunk_index""",
                (document_id,),
            )
            return [StoredChunk(i, h, m) for i, h, m in await cur.fetchall()]

    async def reusable_embeddings(self, hashes: list[str], model: str) -> dict[str, str]:
        """Stored vectors for identical text embedded by the same model, in any document.

        Reuse is what makes re-indexing cheap (FR-8.3): editing one section of a document
        re-embeds that section only. It never exposes text across projects: the vector is only
        reused for a chunk whose own text hashes identically.
        """
        if not hashes:
            return {}
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                """SELECT DISTINCT ON (content_hash) content_hash, embedding::text
                   FROM document_chunks
                   WHERE content_hash = ANY(%s) AND embedding_model = %s""",
                (hashes, model),
            )
            return {h: v for h, v in await cur.fetchall()}

    async def replace_chunks(
        self,
        document: DocumentRow,
        chunks: list[Chunk],
        embeddings: list[str],
        model: str,
    ) -> bool:
        """Swaps the document's chunks in one transaction. Returns False, writing nothing, when
        the document changed or was deleted since it was read: a newer indexing job owns it."""
        async with self._pool.connection() as conn, conn.transaction():
            cur = await conn.execute(
                "SELECT content_hash FROM documents WHERE id = %s FOR UPDATE", (document.id,)
            )
            current = await cur.fetchone()
            if current is None or current[0] != document.content_hash:
                return False
            await conn.execute("DELETE FROM document_chunks WHERE document_id = %s", (document.id,))
            async with conn.cursor() as insert:
                await insert.executemany(
                    """INSERT INTO document_chunks
                         (document_id, project_id, chunk_index, content, token_count,
                          heading_path, content_hash, embedding_model, embedding)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector)""",
                    [
                        (
                            document.id,
                            document.project_id,
                            chunk.index,
                            chunk.content,
                            chunk.token_count,
                            chunk.heading_path,
                            chunk.content_hash,
                            model,
                            embedding,
                        )
                        for chunk, embedding in zip(chunks, embeddings, strict=True)
                    ],
                )
            await conn.execute(
                "UPDATE documents SET indexed_at = now() WHERE id = %s", (document.id,)
            )
        return True

    async def mark_indexed(self, document: DocumentRow) -> bool:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                """UPDATE documents SET indexed_at = now()
                   WHERE id = %s AND content_hash = %s""",
                (document.id, document.content_hash),
            )
            return cur.rowcount == 1

    # ---------------------------------------------------------------- retrieval

    async def vector_search(
        self,
        query_vector: str,
        project_ids: list[uuid.UUID],
        limit: int = CANDIDATES,
        source_types: list[SourceType] | None = None,
        exclude_document: uuid.UUID | None = None,
    ) -> list[Hit]:
        """Nearest chunks by cosine distance, within the given projects only."""
        if not project_ids:
            return []
        async with self._pool.connection() as conn, conn.transaction():
            await conn.execute(f"SET LOCAL hnsw.ef_search = {EF_SEARCH}")
            await conn.execute("SET LOCAL hnsw.iterative_scan = relaxed_order")
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    _SELECT_HIT.format(score="1 - (c.embedding <=> %(q)s::vector)")
                    + """
                       WHERE c.project_id = ANY(%(projects)s)
                         AND (%(types)s::document_source_type[] IS NULL
                              OR d.source_type = ANY(%(types)s::document_source_type[]))
                         AND (%(exclude)s::uuid IS NULL OR c.document_id <> %(exclude)s::uuid)
                       ORDER BY c.embedding <=> %(q)s::vector
                       LIMIT %(limit)s""",
                    {
                        "q": query_vector,
                        "projects": project_ids,
                        "types": source_types,
                        "exclude": exclude_document,
                        "limit": limit,
                    },
                )
                rows = await cur.fetchall()
        # relaxed_order may return near neighbours slightly out of order.
        return sorted((Hit(**row) for row in rows), key=lambda hit: -hit.score)

    async def keyword_search(
        self,
        query: str,
        project_ids: list[uuid.UUID],
        limit: int = CANDIDATES,
        source_types: list[SourceType] | None = None,
    ) -> list[Hit]:
        """Full-text matches ranked by ts_rank_cd, within the given projects only. Catches exact
        tokens that vector search misses: issue keys, error names, identifiers."""
        if not project_ids:
            return []
        async with (
            self._pool.connection() as conn,
            conn.cursor(row_factory=dict_row) as cur,
        ):
            await cur.execute(
                _SELECT_HIT.format(score="ts_rank_cd(c.search_vector, q)")
                + """
                   -- Any term may match (OR), ranked by how many match and how close together.
                   -- An AND query would make long natural-language questions match nothing.
                   CROSS JOIN LATERAL (
                       SELECT replace(
                           plainto_tsquery('english', %(query)s)::text, '&', '|'
                       )::tsquery
                   ) AS terms(q)
                   WHERE c.project_id = ANY(%(projects)s)
                     AND c.search_vector @@ q
                     AND (%(types)s::document_source_type[] IS NULL
                          OR d.source_type = ANY(%(types)s::document_source_type[]))
                   ORDER BY score DESC, c.id
                   LIMIT %(limit)s""",
                {"query": query, "projects": project_ids, "types": source_types, "limit": limit},
            )
            rows = await cur.fetchall()
        return [Hit(**row) for row in rows]

    async def source_vector(
        self, project_id: uuid.UUID, source_type: SourceType, source_id: uuid.UUID
    ) -> tuple[uuid.UUID, str] | None:
        """The stored embedding of a source's first chunk (its title and header), so related
        issues for an existing issue cost no embedding call (architecture §7.3)."""
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                """SELECT d.id, c.embedding::text
                   FROM documents d JOIN document_chunks c ON c.document_id = d.id
                   WHERE d.project_id = %s AND d.source_type = %s::document_source_type
                     AND d.source_id = %s
                   ORDER BY c.chunk_index LIMIT 1""",
                (project_id, source_type, source_id),
            )
            row = await cur.fetchone()
        return (row[0], row[1]) if row else None


# The column list every retrieval query returns; `score` is filled in per query.
_SELECT_HIT = """
    SELECT c.id AS chunk_id, c.document_id, c.project_id, d.source_type::text AS source_type,
           d.source_id, d.title, d.url, c.content, c.heading_path, ({score})::float8 AS score
    FROM document_chunks c
    JOIN documents d ON d.id = c.document_id
"""
