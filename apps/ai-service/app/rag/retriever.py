"""Hybrid retrieval: vector and keyword search combined with reciprocal rank fusion (§7.2).

Vector search finds paraphrases ("can't log in" ≈ "authentication failure"); keyword search finds
exact tokens engineers type (PAY-123, NullPointerException, stripe_webhook). Reciprocal rank
fusion combines the two rankings without comparing their scores, which live on different scales.
"""

import uuid
from dataclasses import dataclass

from app.rag.chunking import SourceType
from app.rag.embedder import EmbeddingProvider, Embeddings
from app.rag.store import Hit, Store, to_vector

# The constant from the original RRF paper (Cormack et al., 2009): it damps the weight of the
# very top ranks so that one list alone cannot dominate.
RRF_K = 60


@dataclass(frozen=True)
class Ranked:
    hit: Hit
    score: float
    vector_rank: int | None
    keyword_rank: int | None


def fuse(vector: list[Hit], keyword: list[Hit], k: int = RRF_K) -> list[Ranked]:
    """score(chunk) = Σ 1 / (k + rank) over the lists it appears in (ranks start at 1)."""
    hits: dict[int, Hit] = {}
    ranks: dict[int, dict[str, int]] = {}
    for name, results in (("vector", vector), ("keyword", keyword)):
        for rank, hit in enumerate(results, start=1):
            hits.setdefault(hit.chunk_id, hit)
            ranks.setdefault(hit.chunk_id, {}).setdefault(name, rank)
    ranked = [
        Ranked(
            hit=hits[chunk_id],
            score=sum(1 / (k + rank) for rank in positions.values()),
            vector_rank=positions.get("vector"),
            keyword_rank=positions.get("keyword"),
        )
        for chunk_id, positions in ranks.items()
    ]
    # Ties (equal fused scores) are broken by chunk ID, so results are stable run to run.
    ranked.sort(key=lambda r: (-r.score, r.hit.chunk_id))
    return ranked


def best_per_document(ranked: list[Ranked]) -> list[Ranked]:
    """Search results list each document once, represented by its best-ranked chunk."""
    seen: set[uuid.UUID] = set()
    best: list[Ranked] = []
    for item in ranked:
        if item.hit.document_id not in seen:
            seen.add(item.hit.document_id)
            best.append(item)
    return best


@dataclass(frozen=True)
class Related:
    hit: Hit
    similarity: float


class Retriever:
    def __init__(self, store: Store, embedder: EmbeddingProvider) -> None:
        self.store = store
        self.embedder = embedder

    async def retrieve(
        self,
        query: str,
        project_ids: list[uuid.UUID],
        source_types: list[SourceType] | None = None,
    ) -> tuple[list[Ranked], Embeddings]:
        """Fused chunk ranking for a query. An empty project list returns nothing (§7.4)."""
        embedded = await self.embedder.embed([query])
        if not project_ids:
            return [], embedded
        vector = await self.store.vector_search(
            to_vector(embedded.vectors[0]), project_ids, source_types=source_types
        )
        keyword = await self.store.keyword_search(query, project_ids, source_types=source_types)
        return fuse(vector, keyword), embedded

    async def related_issues(
        self,
        project_id: uuid.UUID,
        *,
        issue_id: uuid.UUID | None,
        text: str | None,
        limit: int,
        min_score: float,
    ) -> tuple[list[Related], Embeddings | None]:
        """Issues in the same project whose embedding is close to the given issue or text.

        For an indexed issue the stored vector is reused (no embedding call). While drafting,
        there is no issue yet, so the draft text is embedded. Vector-only: this is a similarity
        score with a threshold, and keyword rank has no comparable scale.
        """
        embedded: Embeddings | None = None
        exclude: uuid.UUID | None = None
        vector: str | None = None
        if issue_id is not None:
            stored = await self.store.source_vector(project_id, "ISSUE", issue_id)
            if stored is not None:
                exclude, vector = stored
        if vector is None:
            if not text:
                return [], None
            embedded = await self.embedder.embed([text])
            vector = to_vector(embedded.vectors[0])

        hits = await self.store.vector_search(
            vector, [project_id], limit=limit * 5, source_types=["ISSUE"], exclude_document=exclude
        )
        related: list[Related] = []
        seen: set[uuid.UUID] = set()
        for hit in hits:
            if hit.document_id in seen or hit.score < min_score:
                continue
            if issue_id is not None and hit.source_id == issue_id:
                continue  # an unindexed issue's own document cannot be excluded by ID
            seen.add(hit.document_id)
            related.append(Related(hit, hit.score))
            if len(related) == limit:
                break
        return related, embedded
