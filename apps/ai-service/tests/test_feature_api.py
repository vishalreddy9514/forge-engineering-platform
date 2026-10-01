"""The /v1 feature endpoints over HTTP, as the API calls them."""

import json
import os
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.llm.base import ProviderError
from app.llm.fake import FakeChatProvider
from tests.conftest import TEST_TOKEN

AUTH = {"Authorization": f"Bearer {TEST_TOKEN}"}
CONTRACT = Path(__file__).parent / "contract"

DRAFT_BODY = {
    "text": "Customers are charged twice when the Stripe webhook retries.",
    "projectKey": "PAY",
    "projectName": "Payments",
    "labels": ["bug", "payments", "frontend"],
}
SUMMARY_BODY = {
    "issue": {
        "key": "PAY-1",
        "title": "Double charges",
        "description": "Webhook retries charge twice.",
        "status": "IN_PROGRESS",
        "priority": "CRITICAL",
        "type": "BUG",
    },
    "comments": [
        {
            "author": "Sam Okafor",
            "createdAt": "2026-09-01T10:00:00Z",
            "body": "We decided to store event IDs. Should we backfill old events?",
        }
    ],
}


def events(text: str) -> list[tuple[str, dict[str, Any]]]:
    parsed = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        parsed.append((lines["event"], json.loads(lines["data"])))
    return parsed


def check_contract(name: str, value: dict[str, Any]) -> None:
    """Golden file the API's own tests parse with its Zod schemas: if this shape changes, both
    sides must change together. UPDATE_CONTRACTS=1 rewrites it."""
    path = CONTRACT / f"{name}.json"
    if os.environ.get("UPDATE_CONTRACTS") == "1":
        path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    assert json.loads(path.read_text()) == value


def test_feature_endpoints_require_the_service_token(client: TestClient) -> None:
    assert client.post("/v1/drafts", json=DRAFT_BODY).status_code == 401
    assert client.post("/v1/summaries", json=SUMMARY_BODY).status_code == 401


def test_draft_streams_deltas_then_one_validated_result(client: TestClient) -> None:
    response = client.post("/v1/drafts", json=DRAFT_BODY, headers=AUTH)
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    stream = events(response.text)
    kinds = [kind for kind, _ in stream]
    assert kinds[-1] == "result"
    assert set(kinds[:-1]) == {"delta"}
    assert len(kinds) > 3
    result = stream[-1][1]
    streamed = json.loads("".join(data["text"] for kind, data in stream if kind == "delta"))
    assert streamed["title"] == result["draft"]["title"]
    check_contract("draft_result", result)


def test_draft_drops_labels_that_are_not_the_projects(client: TestClient) -> None:
    reply = {
        "title": "Refunds fail",
        "description": "d",
        "acceptance_criteria": ["Given a, when b, then c"],
        "type": "BUG",
        "priority": "HIGH",
        "priority_rationale": "r",
        "labels": ["Payments", "invented"],
        "technical_area": "payments",
    }
    client.app.state.provider = FakeChatProvider(replies=[json.dumps(reply)])  # type: ignore[attr-defined]
    result = events(client.post("/v1/drafts", json=DRAFT_BODY, headers=AUTH).text)[-1][1]
    assert result["draft"]["labels"] == ["payments"]
    assert result["droppedLabels"] == ["invented"]
    assert result["draft"]["acceptanceCriteria"] == ["Given a, when b, then c"]


def test_draft_reports_invalid_output_with_its_cost(client: TestClient) -> None:
    client.app.state.provider = FakeChatProvider(replies=["{}", "still wrong"])  # type: ignore[attr-defined]
    kind, data = events(client.post("/v1/drafts", json=DRAFT_BODY, headers=AUTH).text)[-1]
    assert kind == "error"
    assert data["code"] == "invalid_output"
    assert data["usage"]["outputTokens"] > 0


class _Down:
    model = "gpt-4.1-mini"

    async def stream(self, *args: object) -> Any:
        raise ProviderError("OpenAI unreachable", retryable=True)
        yield  # pragma: no cover - makes this an async generator


def test_provider_outages_are_distinguishable(client: TestClient) -> None:
    client.app.state.provider = _Down()  # type: ignore[attr-defined]
    kind, data = events(client.post("/v1/drafts", json=DRAFT_BODY, headers=AUTH).text)[-1]
    assert (kind, data["code"]) == ("error", "provider_unavailable")
    assert client.post("/v1/summaries", json=SUMMARY_BODY, headers=AUTH).status_code == 503


@pytest.mark.parametrize(
    "change",
    [
        {"text": "too short"},
        {"projectKey": "pay"},
        {"labels": ["x" * 51]},
        {"unexpected": True},
    ],
)
def test_draft_requests_are_validated(client: TestClient, change: dict[str, Any]) -> None:
    body = {**DRAFT_BODY, **change}
    assert client.post("/v1/drafts", json=body, headers=AUTH).status_code == 422


def test_summary_returns_a_validated_summary(client: TestClient) -> None:
    response = client.post("/v1/summaries", json=SUMMARY_BODY, headers=AUTH)
    assert response.status_code == 200
    body = response.json()
    assert body["summary"]["keyDecisions"] == ["Sam Okafor: We decided to store event IDs."]
    assert body["omittedComments"] == 0
    assert body["promptVersion"] == "thread_summary@1"
    check_contract("summary_response", body)


def test_long_threads_drop_the_oldest_comments_first(client: TestClient) -> None:
    comments = [
        {"author": f"User {i}", "createdAt": "2026-09-01T10:00:00Z", "body": f"{i} " + "x" * 4000}
        for i in range(40)
    ]
    provider = FakeChatProvider()
    client.app.state.provider = provider  # type: ignore[attr-defined]
    body = client.post(
        "/v1/summaries", json={**SUMMARY_BODY, "comments": comments}, headers=AUTH
    ).json()
    assert 0 < body["omittedComments"] < 40
    prompt = provider.calls[0][-1]["content"]
    assert "User 39" in prompt  # the newest is kept
    assert "User 0," not in prompt
    assert f"({body['omittedComments']} earlier comments omitted for length)" in prompt
