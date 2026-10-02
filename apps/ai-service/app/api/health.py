from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/health", tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok"]


@router.get("/live")
def live() -> HealthResponse:
    """The process is up. Never checks dependencies."""
    return HealthResponse(status="ok")


class ReadyResponse(BaseModel):
    status: Literal["ok"]
    provider: str
    model: str
    embedding_model: str = Field(serialization_alias="embeddingModel")
    retrieval: bool


@router.get("/ready")
def ready(request: Request) -> ReadyResponse:
    """Ready to serve, and which provider answers. The provider itself is not called: a slow or
    rate-limited OpenAI must not make every replica look unhealthy (callers degrade instead)."""
    provider = request.app.state.provider
    settings = request.app.state.settings
    return ReadyResponse(
        status="ok",
        provider=settings.provider,
        model=provider.model,
        embedding_model=request.app.state.embedder.model,
        # Whether retrieval is configured, not whether the database answers right now.
        retrieval=request.app.state.store is not None,
    )
