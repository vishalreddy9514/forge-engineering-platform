from typing import Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel

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


@router.get("/ready")
def ready(request: Request) -> ReadyResponse:
    """Ready to serve, and which provider answers. The provider itself is not called: a slow or
    rate-limited OpenAI must not make every replica look unhealthy (callers degrade instead)."""
    provider = request.app.state.provider
    settings = request.app.state.settings
    return ReadyResponse(status="ok", provider=settings.provider, model=provider.model)
