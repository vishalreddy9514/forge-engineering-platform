"""Prometheus metrics: HTTP by route template, and every provider call metered (§11)."""

import socket
import urllib.request
from collections.abc import AsyncGenerator, AsyncIterator, Sequence
from typing import cast

import pytest
from fastapi.testclient import TestClient
from prometheus_client import REGISTRY

from app.core.metrics import current_feature, route_template, start_metrics_server
from app.llm.base import (
    ChatEvent,
    ChatMessage,
    Completion,
    Message,
    OutputSchema,
    ProviderError,
    StreamEvent,
    TextDelta,
    Tool,
    Usage,
)
from app.llm.metered import MeteredChatProvider, MeteredEmbedder
from app.rag.embedder import Embeddings
from tests.conftest import AUTH
from tests.test_feature_api import DRAFT_BODY, events

SCHEMA = OutputSchema(name="s", schema={})


def sample(name: str, **labels: str) -> float:
    return REGISTRY.get_sample_value(name, labels) or 0.0


def test_http_requests_are_labelled_by_route_template(client: TestClient) -> None:
    labels = {"method": "GET", "route": "/health/live", "status": "200"}
    before = sample("forge_ai_http_request_duration_seconds_count", **labels)
    unmatched = {"method": "GET", "route": "unmatched", "status": "404"}
    before_404 = sample("forge_ai_http_request_duration_seconds_count", **unmatched)

    client.get("/health/live")
    client.get("/v1/no-such-thing/123")

    assert sample("forge_ai_http_request_duration_seconds_count", **labels) == before + 1
    assert sample("forge_ai_http_request_duration_seconds_count", **unmatched) == before_404 + 1


def test_nested_routes_are_labelled_with_their_full_template(client: TestClient) -> None:
    labels = {"method": "POST", "route": "/v1/drafts", "status": "200"}
    before = sample("forge_ai_http_request_duration_seconds_count", **labels)
    client.post("/v1/drafts", json=DRAFT_BODY, headers=AUTH)
    assert sample("forge_ai_http_request_duration_seconds_count", **labels) == before + 1


def test_path_parameters_become_placeholders() -> None:
    scope = {
        "route": object(),
        "path": "/v1/documents/3f1c/chunks",
        "path_params": {"document_id": "3f1c"},
    }
    assert route_template(scope) == "/v1/documents/{document_id}/chunks"
    assert route_template({"path": "/wp-login.php"}) == "unmatched"


def test_a_draft_records_its_latency_tokens_and_cost(client: TestClient) -> None:
    labels = {"feature": "/v1/drafts", "operation": "structured", "model": "fake", "outcome": "ok"}
    before = sample("forge_llm_request_duration_seconds_count", **labels)
    tokens = {"feature": "/v1/drafts", "model": "fake", "direction": "input"}
    tokens_before = sample("forge_llm_tokens_total", **tokens)

    response = client.post("/v1/drafts", json=DRAFT_BODY, headers=AUTH)
    usage = events(response.text)[-1][1]["usage"]

    assert sample("forge_llm_request_duration_seconds_count", **labels) == before + 1
    assert sample("forge_llm_tokens_total", **tokens) == tokens_before + usage["inputTokens"]


class _Scripted:
    """A provider whose stream yields a delta and then either completes or fails."""

    model = "gpt-4.1-mini"

    def __init__(self, error: BaseException | None = None) -> None:
        self.error = error

    async def stream(
        self, messages: list[Message], schema: OutputSchema, max_output_tokens: int
    ) -> AsyncIterator[StreamEvent]:
        yield TextDelta("partial")
        if self.error:
            raise self.error
        yield Completion("done", "gpt-4.1-mini-2025-04-14", Usage(1_000_000, 500_000))

    async def stream_chat(
        self, messages: Sequence[ChatMessage], tools: list[Tool], max_output_tokens: int
    ) -> AsyncIterator[ChatEvent]:
        yield Completion("", self.model, Usage(10, 0))


async def _drain(provider: MeteredChatProvider) -> None:
    async for _ in provider.stream([], SCHEMA, 100):
        pass


def _count(outcome: str, model: str = "gpt-4.1-mini") -> float:
    return sample(
        "forge_llm_request_duration_seconds_count",
        feature="test",
        operation="structured",
        model=model,
        outcome=outcome,
    )


@pytest.fixture(autouse=True)
def _feature() -> object:
    token = current_feature.set("test")
    yield
    current_feature.reset(token)


async def test_completed_calls_are_costed_by_the_reported_model() -> None:
    model = "gpt-4.1-mini-2025-04-14"
    cost = sample("forge_llm_cost_usd_total", feature="test", model=model)
    before = _count("ok", model)
    await _drain(MeteredChatProvider(_Scripted()))
    assert _count("ok", model) == before + 1
    # 1M input tokens at $0.40 plus 0.5M output tokens at $1.60 (app/llm/pricing.py).
    assert sample("forge_llm_cost_usd_total", feature="test", model=model) == pytest.approx(
        cost + 1.2
    )


@pytest.mark.parametrize(
    ("error", "outcome"),
    [
        (ProviderError("rate limited", retryable=True), "error_retryable"),
        (ProviderError("refused", retryable=False), "error_permanent"),
        (RuntimeError("bug"), "error"),
    ],
)
async def test_failures_are_counted_by_kind(error: BaseException, outcome: str) -> None:
    before = _count(outcome)
    with pytest.raises(type(error)):
        await _drain(MeteredChatProvider(_Scripted(error)))
    assert _count(outcome) == before + 1


async def test_a_stream_abandoned_by_the_client_counts_as_cancelled() -> None:
    before = _count("cancelled")
    stream = cast(
        AsyncGenerator[StreamEvent], MeteredChatProvider(_Scripted()).stream([], SCHEMA, 100)
    )
    await anext(stream)  # the client reads one delta, then disconnects
    await stream.aclose()
    assert _count("cancelled") == before + 1


async def test_embeddings_are_metered_on_input_tokens() -> None:
    class Embedder:
        model = "text-embedding-3-small"
        related_threshold = 0.5

        async def embed(self, texts: list[str]) -> Embeddings:
            return Embeddings([[0.0]] * len(texts), self.model, 42)

    tokens = {"feature": "test", "model": "text-embedding-3-small", "direction": "input"}
    before = sample("forge_llm_tokens_total", **tokens)
    metered = MeteredEmbedder(Embedder())
    assert metered.related_threshold == 0.5
    await metered.embed(["a", "b"])
    assert sample("forge_llm_tokens_total", **tokens) == before + 42


def test_the_metrics_server_serves_prometheus_text() -> None:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    assert start_metrics_server(port) is True
    # A second server on the same port is refused quietly instead of crashing the service.
    assert start_metrics_server(port) is False
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=5) as response:
        body = response.read().decode()
    assert "forge_llm_request_duration_seconds" in body
