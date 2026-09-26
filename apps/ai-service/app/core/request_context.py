import re
import time
import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

REQUEST_ID_HEADER = "x-request-id"
_SAFE_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,128}$")

logger = structlog.get_logger("app.access")


def resolve_request_id(incoming: str | None) -> str:
    """Reuse the caller's request ID when it is safe to log, otherwise mint a new one.

    Mirrors the API's rule so one ID follows a request across both services.
    """
    if incoming and _SAFE_REQUEST_ID.fullmatch(incoming):
        return incoming
    return str(uuid.uuid4())


class RequestContextMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = resolve_request_id(request.headers.get(REQUEST_ID_HEADER))
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id, service="ai-service")
        request.state.request_id = request_id

        started = time.perf_counter()
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request_id

        if not request.url.path.startswith("/health/"):
            logger.info(
                "request completed",
                method=request.method,
                path=request.url.path,
                status=response.status_code,
                duration_ms=round((time.perf_counter() - started) * 1000, 1),
            )
        return response
