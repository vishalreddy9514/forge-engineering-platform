"""Indexing one document: chunk → reuse or embed → store (FR-8.2, FR-8.3).

The API writes the `documents` row (normalised text and its hash) and then asks for it to be
indexed. Indexing is idempotent and incremental:

- unchanged chunks with vectors from the current model are not re-embedded;
- identical text anywhere in the corpus reuses its stored vector;
- if the document changed while it was being embedded, nothing is written, because the job
  queued for that newer change will index it.
"""

import uuid
from dataclasses import dataclass
from typing import Literal

from app.rag.chunking import chunk_document
from app.rag.embedder import EmbeddingProvider
from app.rag.store import Store, to_vector

IndexStatus = Literal["indexed", "unchanged", "stale", "missing"]


@dataclass(frozen=True)
class IndexResult:
    status: IndexStatus
    chunks: int = 0
    embedded: int = 0
    reused: int = 0
    input_tokens: int = 0


async def index_document(
    store: Store, embedder: EmbeddingProvider, document_id: uuid.UUID
) -> IndexResult:
    document = await store.load_document(document_id)
    if document is None:
        return IndexResult("missing")

    chunks = chunk_document(document.source_type, document.title, document.content)
    stored = await store.stored_chunks(document.id)
    wanted = [(c.index, c.content_hash, embedder.model) for c in chunks]
    if wanted == [(s.index, s.content_hash, s.embedding_model) for s in stored]:
        marked = await store.mark_indexed(document)
        return IndexResult("unchanged" if marked else "stale", chunks=len(chunks))

    reusable = await store.reusable_embeddings([c.content_hash for c in chunks], embedder.model)
    # Embed each distinct new text once, even if it repeats within the document.
    pending = {c.content_hash: c for c in chunks if c.content_hash not in reusable}
    tokens = 0
    if pending:
        embedded = await embedder.embed(
            [c.embedding_input(document.title) for c in pending.values()]
        )
        tokens = embedded.input_tokens
        for content_hash, values in zip(pending, embedded.vectors, strict=True):
            reusable[content_hash] = to_vector(values)

    written = await store.replace_chunks(
        document, chunks, [reusable[c.content_hash] for c in chunks], embedder.model
    )
    return IndexResult(
        "indexed" if written else "stale",
        chunks=len(chunks),
        embedded=len(pending),
        reused=sum(1 for c in chunks if c.content_hash not in pending),
        input_tokens=tokens,
    )
