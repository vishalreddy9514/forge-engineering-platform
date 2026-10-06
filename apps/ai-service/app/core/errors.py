"""Error reporting to Sentry (architecture §11), on only when SENTRY_DSN is set.

Reports carry the request ID, service and stack, never credentials or personal data: no
authenticating headers, no bodies (issue text, comments, prompts), no query strings, no local
variables (they hold prompts and answers), no user.
"""

from typing import Any

import sentry_sdk
import structlog

from app.core.config import Settings

_DROPPED_HEADERS = {"authorization", "cookie", "x-forwarded-for", "referer"}


def scrub_event(event: Any, hint: Any = None) -> Any:
    request = event.get("request")
    if isinstance(request, dict):
        headers = request.get("headers")
        if isinstance(headers, dict):
            request["headers"] = {
                name: value
                for name, value in headers.items()
                if name.lower() not in _DROPPED_HEADERS
            }
        for key in ("data", "cookies", "query_string", "env"):
            request.pop(key, None)
        if isinstance(request.get("url"), str):
            request["url"] = request["url"].split("?")[0]
    event.pop("user", None)
    request_id = structlog.contextvars.get_contextvars().get("request_id")
    if request_id:
        event.setdefault("tags", {})["request_id"] = request_id
    return event


def init_error_reporting(settings: Settings) -> bool:
    if settings.sentry_dsn is None:
        return False
    sentry_sdk.init(
        dsn=settings.sentry_dsn.get_secret_value(),
        environment=settings.sentry_environment or settings.environment,
        release=settings.sentry_release,
        send_default_pii=False,
        max_request_body_size="never",
        include_local_variables=False,
        # Errors only: latency lives in Prometheus.
        traces_sample_rate=0,
        before_send=scrub_event,
    )
    sentry_sdk.set_tag("service", "ai-service")
    return True
