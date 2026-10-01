"""FR-8 endpoints: indexing, semantic search, related issues and assistant chat.

The API calls these with the service token and always passes the caller's accessible project
IDs; this service never decides who may see what, it only filters by what it is given (§7.4).
"""

import uuid
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Annotated, Any, Literal

import psycopg
import structlog
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from psycopg_pool import PoolTimeout
from pydantic import Field, StringConstraints

from app.api.deps import AppSettings, Embedder, Provider, RetrieverDep, StoreDep
from app.api.schemas import UsageOut
from app.api.streaming import SSE_HEADERS, sse
from app.core.config import Settings
from app.core.wire import Wire
from app.features import chat
from app.llm.base import ProviderError, TextDelta, Usage
from app.llm.pricing import estimate_cost
from app.rag.answer import Source
from app.rag.chunking import SourceType, TooManyChunksError
from app.rag.embedder import Embeddings
from app.rag.indexer import IndexStatus, index_document
from app.rag.retriever import best_per_document

router = APIRouter(tags=["retrieval"])
_log = structlog.get_logger(__name__)

ProjectIds = Annotated[list[uuid.UUID], Field(max_length=500)]
SNIPPET_CHARS = 300


class EmbeddingUsageOut(Wire):
    model: str
    input_tokens: int
    cost_usd: Decimal

    @classmethod
    def of(cls, embeddings: Embeddings | None, model: str) -> "EmbeddingUsageOut":
        tokens = embeddings.input_tokens if embeddings else 0
        used = embeddings.model if embeddings else model
        return cls(model=used, input_tokens=tokens, cost_usd=estimate_cost(used, Usage(tokens, 0)))


# ------------------------------------------------------------------ indexing


class IndexRequest(Wire):
    document_id: uuid.UUID


class IndexResponse(Wire):
    status: IndexStatus | Literal["rejected"]
    chunks: int
    embedded: int
    reused: int
    embedding: EmbeddingUsageOut
    detail: str | None = None


@router.post("/index")
async def index(body: IndexRequest, store: StoreDep, embedder: Embedder) -> IndexResponse:
    """Indexes one document the API has written. Safe to repeat: unchanged chunks are kept."""
    try:
        result = await index_document(store, embedder, body.document_id)
    except TooManyChunksError as error:
        # Not retryable: the same document will be rejected again until it is changed.
        return IndexResponse(
            status="rejected",
            chunks=0,
            embedded=0,
            reused=0,
            embedding=EmbeddingUsageOut.of(None, embedder.model),
            detail=str(error),
        )
    tokens = Embeddings([], embedder.model, result.input_tokens)
    return IndexResponse(
        status=result.status,
        chunks=result.chunks,
        embedded=result.embedded,
        reused=result.reused,
        embedding=EmbeddingUsageOut.of(tokens, embedder.model),
    )


# ------------------------------------------------------------------ search


class SearchRequest(Wire):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
    project_ids: ProjectIds
    source_types: Annotated[list[SourceType], Field(max_length=5)] | None = None
    limit: Annotated[int, Field(ge=1, le=50)] = 20


class SearchResult(Wire):
    document_id: uuid.UUID
    project_id: uuid.UUID
    source_type: SourceType
    source_id: uuid.UUID | None
    title: str
    url: str
    heading_path: str | None
    snippet: str
    score: float
    vector_rank: int | None
    keyword_rank: int | None


class SearchResponse(Wire):
    results: list[SearchResult]
    embedding: EmbeddingUsageOut


def _snippet(text: str) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= SNIPPET_CHARS else flat[: SNIPPET_CHARS - 1].rstrip() + "…"


@router.post("/search")
async def search(body: SearchRequest, retriever: RetrieverDep) -> SearchResponse:
    """Semantic search (FR-11.2): hybrid retrieval, one result per document."""
    ranked, embedded = await retriever.retrieve(body.query, body.project_ids, body.source_types)
    results = [
        SearchResult(
            document_id=item.hit.document_id,
            project_id=item.hit.project_id,
            source_type=item.hit.source_type,
            source_id=item.hit.source_id,
            title=item.hit.title,
            url=item.hit.url,
            heading_path=item.hit.heading_path,
            snippet=_snippet(item.hit.content),
            score=round(item.score, 6),
            vector_rank=item.vector_rank,
            keyword_rank=item.keyword_rank,
        )
        for item in best_per_document(ranked)[: body.limit]
    ]
    return SearchResponse(
        results=results, embedding=EmbeddingUsageOut.of(embedded, retriever.embedder.model)
    )


# ------------------------------------------------------------------ related issues


class RelatedRequest(Wire):
    project_id: uuid.UUID
    # An existing issue (its stored vector is reused), or draft text, or both: the text is
    # used when the issue has not been indexed yet.
    issue_id: uuid.UUID | None = None
    text: Annotated[str, StringConstraints(strip_whitespace=True, max_length=8000)] | None = None
    limit: Annotated[int, Field(ge=1, le=20)] = 5
    min_score: Annotated[float, Field(ge=0, le=1)] | None = None


class RelatedIssue(Wire):
    issue_id: uuid.UUID
    document_id: uuid.UUID
    title: str
    url: str
    score: float


class RelatedResponse(Wire):
    results: list[RelatedIssue]
    threshold: float
    embedding: EmbeddingUsageOut


def related_threshold(settings: Settings, model_default: float) -> float:
    return settings.related_min_score if settings.related_min_score is not None else model_default


@router.post("/related")
async def related(
    body: RelatedRequest, retriever: RetrieverDep, settings: AppSettings
) -> RelatedResponse:
    """Similar issues in the same project (FR-7.3), above a similarity threshold."""
    threshold = (
        body.min_score
        if body.min_score is not None
        else related_threshold(settings, retriever.embedder.related_threshold)
    )
    found, embedded = await retriever.related_issues(
        body.project_id,
        issue_id=body.issue_id,
        text=body.text,
        limit=body.limit,
        min_score=threshold,
    )
    return RelatedResponse(
        results=[
            RelatedIssue(
                issue_id=item.hit.source_id,
                document_id=item.hit.document_id,
                title=item.hit.title,
                url=item.hit.url,
                score=round(item.similarity, 4),
            )
            for item in found
            if item.hit.source_id is not None
        ],
        threshold=threshold,
        embedding=EmbeddingUsageOut.of(embedded, retriever.embedder.model),
    )


# ------------------------------------------------------------------ chat


def _citation(source: Source) -> dict[str, Any]:
    return {
        "n": source.n,
        "sourceType": source.source_type,
        "sourceId": source.source_id,
        "documentId": source.document_id,
        "projectId": source.project_id,
        "title": source.title,
        "url": source.url,
        "headingPath": source.heading_path,
    }


@router.post("/chat")
async def chat_turn(
    body: chat.ChatRequest, retriever: RetrieverDep, provider: Provider
) -> StreamingResponse:
    """Streams `delta` events, then exactly one of: `tool_call` (the API runs query_issues and
    calls again with the result), `result` (the answer and its citations), or `error`. The
    terminal event carries usage for the chat model and for the query embedding."""

    def usage(model: str, used: Usage, embedding: Embeddings | None) -> dict[str, Any]:
        return {
            "model": model,
            "promptVersion": chat.CHAT_PROMPT_VERSION,
            "usage": UsageOut.of(model, used).model_dump(mode="json"),
            "embedding": EmbeddingUsageOut.of(embedding, retriever.embedder.model).model_dump(
                mode="json"
            ),
        }

    async def events() -> AsyncIterator[bytes]:
        try:
            async for event in chat.run(body, retriever, provider):
                if isinstance(event, TextDelta):
                    yield sse("delta", {"text": event.text})
                elif isinstance(event, chat.ChatToolRequest):
                    yield sse(
                        "tool_call",
                        {
                            "id": event.call.id,
                            "name": event.call.name,
                            "arguments": event.arguments,
                            "rawArguments": event.call.arguments,
                            **usage(
                                event.completion.model, event.completion.usage, event.embedding
                            ),
                        },
                    )
                else:
                    yield sse(
                        "result",
                        {
                            "answer": event.answer,
                            "citations": [_citation(s) for s in event.citations],
                            **usage(
                                event.completion.model, event.completion.usage, event.embedding
                            ),
                        },
                    )
        except ProviderError as error:
            _log.warning("chat failed", error=str(error), retryable=error.retryable)
            code = "provider_unavailable" if error.retryable else "provider_error"
            yield sse("error", {"code": code, "message": str(error)})
        except (psycopg.OperationalError, PoolTimeout) as error:
            _log.warning("chat retrieval failed", error=str(error))
            yield sse(
                "error",
                {"code": "retrieval_unavailable", "message": "The retrieval store is unavailable"},
            )

    return StreamingResponse(events(), media_type="text/event-stream", headers=SSE_HEADERS)
