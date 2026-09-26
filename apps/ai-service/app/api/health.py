from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/health", tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok"]


@router.get("/live")
def live() -> HealthResponse:
    """The process is up. Never checks dependencies."""
    return HealthResponse(status="ok")


@router.get("/ready")
def ready() -> HealthResponse:
    """Ready to serve. Database and model-provider checks are added with those clients (Phase 9)."""
    return HealthResponse(status="ok")
