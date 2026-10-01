from typing import Annotated

from fastapi import Depends, HTTPException, Request, status

from app.core.config import Settings, get_settings
from app.llm.base import ChatProvider
from app.rag.embedder import EmbeddingProvider
from app.rag.retriever import Retriever
from app.rag.store import Store


def get_provider(request: Request) -> ChatProvider:
    provider: ChatProvider = request.app.state.provider
    return provider


def get_embedder(request: Request) -> EmbeddingProvider:
    embedder: EmbeddingProvider = request.app.state.embedder
    return embedder


def get_store(request: Request) -> Store:
    store: Store | None = request.app.state.store
    if store is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE, "Retrieval is not configured (AI_DATABASE_URL)"
        )
    return store


def get_retriever(
    store: Annotated[Store, Depends(get_store)],
    embedder: Annotated[EmbeddingProvider, Depends(get_embedder)],
) -> Retriever:
    return Retriever(store, embedder)


Provider = Annotated[ChatProvider, Depends(get_provider)]
AppSettings = Annotated[Settings, Depends(get_settings)]
Embedder = Annotated[EmbeddingProvider, Depends(get_embedder)]
StoreDep = Annotated[Store, Depends(get_store)]
RetrieverDep = Annotated[Retriever, Depends(get_retriever)]
