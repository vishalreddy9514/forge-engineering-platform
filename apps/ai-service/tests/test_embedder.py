import json
import math
from typing import Any

import httpx2 as httpx
import pytest
from openai import AsyncOpenAI

from app.llm.base import ProviderError, Usage
from app.llm.pricing import estimate_cost
from app.rag.embedder import DIMENSIONS, FakeEmbedder, OpenAIEmbedder, fake_vector


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b, strict=True))


def test_fake_vectors_are_deterministic_unit_vectors() -> None:
    vector = fake_vector("Stripe webhook retries")
    assert len(vector) == DIMENSIONS
    assert math.isclose(sum(v * v for v in vector), 1.0, rel_tol=1e-9)
    assert vector == fake_vector("Stripe webhook retries")
    assert math.isclose(sum(v * v for v in fake_vector("!!!")), 1.0)


def test_fake_similarity_follows_shared_wording() -> None:
    query = fake_vector("customers charged twice after webhook retries")
    close = fake_vector("Stripe webhook retries charge customers twice")
    far = fake_vector("Add a dark colour theme to settings")
    assert cosine(query, close) > 0.5 > cosine(query, far)
    # Stems and compound parts: "retrying" ~ "retries", "stripe_webhook" ~ "webhook".
    assert cosine(fake_vector("retrying"), fake_vector("retries")) == pytest.approx(1.0)
    assert cosine(fake_vector("stripe_webhook"), fake_vector("webhook")) > 0.3


async def test_the_fake_embedder_reports_estimated_tokens() -> None:
    embedder = FakeEmbedder()
    result = await embedder.embed(["abcd" * 10, "x"])
    assert result.model == "fake-embedding-1"
    assert result.input_tokens == 11
    assert len(result.vectors) == 2


def embedder_for(handler: Any) -> OpenAIEmbedder:
    client = AsyncOpenAI(
        api_key="sk-test",
        base_url="https://openai.test/v1",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return OpenAIEmbedder(client, "text-embedding-3-small")


async def test_openai_embeddings_are_batched_and_returned_in_input_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("app.rag.embedder.BATCH_SIZE", 2)
    requests: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        requests.append(body)
        # Deliberately out of order: the response's index field decides the position.
        data = [
            {"object": "embedding", "index": i, "embedding": [float(len(text))] * 3}
            for i, text in reversed(list(enumerate(body["input"])))
        ]
        return httpx.Response(
            200,
            json={
                "object": "list",
                "data": data,
                "model": body["model"],
                "usage": {"prompt_tokens": 5, "total_tokens": 5},
            },
        )

    result = await embedder_for(handler).embed(["a", "bb", "ccc"])

    assert [r["input"] for r in requests] == [["a", "bb"], ["ccc"]]
    assert all(
        r["dimensions"] == DIMENSIONS and r["model"] == "text-embedding-3-small" for r in requests
    )
    assert [v[0] for v in result.vectors] == [1.0, 2.0, 3.0]
    assert result.input_tokens == 10


@pytest.mark.parametrize(("status", "retryable"), [(429, True), (500, True), (400, False)])
async def test_openai_embedding_errors_map_to_provider_errors(status: int, retryable: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "nope"}})

    with pytest.raises(ProviderError) as caught:
        await embedder_for(handler).embed(["a"])
    assert caught.value.retryable is retryable


def test_embeddings_are_priced_on_input_tokens() -> None:
    assert str(estimate_cost("text-embedding-3-small", Usage(1_000_000, 0))) == "0.020000"
    assert str(estimate_cost("fake-embedding-1", Usage(1_000_000, 0))) == "0.000000"
