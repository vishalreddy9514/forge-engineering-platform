"""Error reporting: scrubbed of credentials and personal data, tagged with the request ID."""

import gzip
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any

import pytest
import sentry_sdk
import structlog
from pydantic import SecretStr

from app.core.config import Settings
from app.core.errors import init_error_reporting, scrub_event
from tests.conftest import TEST_TOKEN


def test_scrub_drops_credentials_bodies_queries_and_the_user() -> None:
    event: dict[str, Any] = {
        "exception": {"values": [{"type": "ProviderError", "value": "boom"}]},
        "user": {"ip_address": "203.0.113.9"},
        "request": {
            "url": "http://ai-service:8000/v1/drafts?debug=1",
            "query_string": "debug=1",
            "data": {"text": "Customer Jane Doe's card was charged twice"},
            "headers": {"Authorization": "Bearer secret", "user-agent": "forge-api"},
        },
    }
    structlog.contextvars.bind_contextvars(request_id="req-ai-1")
    try:
        scrubbed = scrub_event(event)
    finally:
        structlog.contextvars.clear_contextvars()
    assert scrubbed["request"] == {
        "url": "http://ai-service:8000/v1/drafts",
        "headers": {"user-agent": "forge-api"},
    }
    assert "user" not in scrubbed
    assert scrubbed["tags"]["request_id"] == "req-ai-1"


def test_reporting_is_off_without_a_dsn() -> None:
    assert init_error_reporting(Settings(service_token=SecretStr(TEST_TOKEN))) is False


@pytest.fixture
def sentry_endpoint() -> Iterator[tuple[str, list[str]]]:
    received: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            received.append(body.decode())
            self.send_response(200)
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://public@127.0.0.1:{server.server_port}/1", received
    server.shutdown()
    server.server_close()


def test_an_error_reaches_sentry_without_the_prompt(
    sentry_endpoint: tuple[str, list[str]],
) -> None:
    dsn, received = sentry_endpoint
    settings = Settings(service_token=SecretStr(TEST_TOKEN), sentry_dsn=SecretStr(dsn))
    assert init_error_reporting(settings) is True
    try:
        # Built at run time: a literal would appear in the source context Sentry attaches.
        prompt = "-".join(["customer", "jane", "doe", "charged", "twice"])
        structlog.contextvars.bind_contextvars(request_id="req-ai-2")
        try:
            raise RuntimeError(f"draft parser exploded after {len(prompt)} characters")
        except RuntimeError:
            sentry_sdk.capture_exception()
        sentry_sdk.flush(timeout=5)
        sent = "\n".join(received)
        assert "draft parser exploded" in sent
        assert '"request_id":"req-ai-2"' in sent
        assert '"service":"ai-service"' in sent
        assert prompt not in sent  # local variables are not collected
    finally:
        structlog.contextvars.clear_contextvars()
        sentry_sdk.get_client().close()
