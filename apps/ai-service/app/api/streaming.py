"""Server-sent events, as the API relays them to the browser."""

import json
from typing import Any

# Proxies must not buffer the stream (Nginx honours X-Accel-Buffering).
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def sse(event: str, data: dict[str, Any]) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n".encode()
