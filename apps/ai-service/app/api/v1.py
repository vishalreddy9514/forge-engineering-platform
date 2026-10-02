from fastapi import APIRouter, Request
from pydantic import BaseModel

from app.api import features, rag
from app.core.security import ServiceAuth

# Every feature endpoint lives under this router and therefore requires the service token.
router = APIRouter(prefix="/v1", dependencies=[ServiceAuth])


class WhoAmIResponse(BaseModel):
    caller: str
    request_id: str


@router.get("/whoami", tags=["meta"])
def whoami(request: Request) -> WhoAmIResponse:
    """Authenticated no-op the API uses to verify connectivity and credentials end to end."""
    request_id: str = request.state.request_id  # set by RequestContextMiddleware
    return WhoAmIResponse(caller="internal-service", request_id=request_id)


router.include_router(features.router)
router.include_router(rag.router)
