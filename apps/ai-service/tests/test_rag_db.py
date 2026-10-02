"""Indexing, retrieval, related issues and chat against real Postgres + pgvector, over HTTP as
the API calls them, connected as the least-privilege forge_ai role."""

import json
import re
import uuid
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.rag.embedder import Embeddings, FakeEmbedder
from app.rag.indexer import index_document
from app.rag.store import Store
from tests.conftest import AUTH
from tests.db import Fixtures, ScratchDatabase
from tests.test_feature_api import check_contract


def index(client: TestClient, document_id: uuid.UUID) -> dict[str, Any]:
    response = client.post("/v1/index", json={"documentId": str(document_id)}, headers=AUTH)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def search(client: TestClient, query: str, projects: list[uuid.UUID], **extra: Any) -> list[Any]:
    body = {"query": query, "projectIds": [str(p) for p in projects], **extra}
    response = client.post("/v1/search", json=body, headers=AUTH)
    assert response.status_code == 200, response.text
    results: list[Any] = response.json()["results"]
    return results


def events(text: str) -> list[tuple[str, dict[str, Any]]]:
    parsed = []
    for block in text.strip().split("\n\n"):
        lines = dict(line.split(": ", 1) for line in block.splitlines())
        parsed.append((lines["event"], json.loads(lines["data"])))
    return parsed


RUNBOOK = """# Payments runbook

## Stripe webhooks

Webhook deliveries are deduplicated by event ID in processed_stripe_events.
If receipts are sent twice, check that table first.

## Reconciliation

The nightly reconciliation job streams transactions in batches of 10,000.
At month end volume triples; the job has a 30 minute limit.
"""


class TestIndexing:
    def test_chunks_embeds_and_stores_a_document(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, _ = fixtures.document(project, "Payments runbook", RUNBOOK, source_type="UPLOAD")

        result = index(rag_client, doc)

        assert result["status"] == "indexed"
        assert result["chunks"] == 2
        assert result["embedded"] == 2
        assert result["embedding"]["model"] == "fake-embedding-1"
        assert result["embedding"]["inputTokens"] > 0
        chunks = fixtures.chunks(doc)
        assert [c["heading_path"] for c in chunks] == [
            "Payments runbook > Stripe webhooks",
            "Payments runbook > Reconciliation",
        ]
        assert all(c["embedding_model"] == "fake-embedding-1" for c in chunks)
        indexed = fixtures.conn.execute("SELECT indexed_at FROM documents WHERE id = %s", (doc,))
        assert indexed.fetchone()[0] is not None  # type: ignore[index]

    def test_reindexing_an_unchanged_document_embeds_nothing(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, _ = fixtures.document(project, "Runbook", RUNBOOK, source_type="UPLOAD")
        index(rag_client, doc)

        again = index(rag_client, doc)

        assert again["status"] == "unchanged"
        assert again["embedded"] == 0
        assert again["embedding"]["inputTokens"] == 0

    def test_editing_one_section_re_embeds_only_that_section(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, _ = fixtures.document(project, "Runbook", RUNBOOK, source_type="UPLOAD")
        index(rag_client, doc)
        before = fixtures.chunks(doc)

        fixtures.update_document(doc, "Runbook", RUNBOOK.replace("10,000", "5,000"))
        result = index(rag_client, doc)

        assert result["status"] == "indexed"
        assert (result["embedded"], result["reused"]) == (1, 1)
        after = fixtures.chunks(doc)
        assert after[0]["embedding"] == before[0]["embedding"]
        assert after[1]["embedding"] != before[1]["embedding"]
        assert "5,000" in after[1]["content"]

    def test_identical_text_in_another_document_reuses_the_stored_vector(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        first, _ = fixtures.document(project, "Runbook", RUNBOOK, source_type="UPLOAD")
        second, _ = fixtures.document(project, "Runbook", RUNBOOK, source_type="UPLOAD")
        index(rag_client, first)

        result = index(rag_client, second)

        assert (result["embedded"], result["reused"]) == (0, 2)

    def test_a_deleted_document_reports_missing(self, rag_client: TestClient) -> None:
        assert index(rag_client, uuid.uuid4())["status"] == "missing"

    def test_an_empty_document_has_no_chunks(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, _ = fixtures.document(project, "Empty", "   ", source_type="UPLOAD")
        assert index(rag_client, doc)["chunks"] == 0
        assert fixtures.chunks(doc) == []

    def test_chunks_are_deleted_with_their_document(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, _ = fixtures.document(project, "Runbook", RUNBOOK, source_type="UPLOAD")
        index(rag_client, doc)
        fixtures.conn.execute("DELETE FROM documents WHERE id = %s", (doc,))
        assert fixtures.chunks(doc) == []


class TestConcurrentEdits:
    async def test_a_document_edited_during_embedding_is_left_to_the_newer_job(
        self, store: Store, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        # Unique text: identical chunks elsewhere would be reused without calling the embedder.
        text = f"{RUNBOOK}\n\n## Owner\n\nTeam {uuid.uuid4()}."
        doc, _ = fixtures.document(project, "Runbook", text, source_type="UPLOAD")

        class EditingEmbedder(FakeEmbedder):
            """Simulates someone saving a new version while the old one is being embedded."""

            async def embed(self, texts: list[str]) -> Embeddings:
                fixtures.update_document(doc, "Runbook", f"{text}\n\n## New section\n\nText.")
                return await super().embed(texts)

        result = await index_document(store, EditingEmbedder(), doc)

        assert result.status == "stale"
        assert fixtures.chunks(doc) == []  # nothing from the old version was written
        assert (await index_document(store, FakeEmbedder(), doc)).status == "indexed"
        assert len(fixtures.chunks(doc)) == 4


class TestSearch:
    def test_hybrid_search_finds_paraphrases_and_exact_tokens(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        webhook, _ = fixtures.document(
            project,
            "PAY-1: Stripe webhook retries can double-charge customers",
            # The API writes a header line like this into every issue's normalised content.
            "Issue PAY-1: Stripe webhook retries can double-charge customers\n\n"
            "When the webhook handler times out Stripe retries payment_intent.succeeded and "
            "customers are charged twice.",
        )
        login, _ = fixtures.document(
            project,
            "AUTH-1: Users cannot reset their password",
            "Issue AUTH-1: Users cannot reset their password\n\n"
            "The password reset email link expires immediately because of a timezone bug.",
        )
        for doc in (webhook, login):
            index(rag_client, doc)

        by_words = search(rag_client, "customers charged twice by stripe", [project])
        by_key = search(rag_client, "PAY-1", [project])
        by_identifier = search(rag_client, "payment_intent.succeeded", [project])

        assert by_words[0]["documentId"] == str(webhook)
        assert by_key[0]["documentId"] == str(webhook)
        assert by_key[0]["keywordRank"] == 1
        assert by_identifier[0]["documentId"] == str(webhook)
        assert by_words[0]["snippet"].startswith("Issue PAY-1: Stripe webhook")

    def test_results_never_include_projects_the_caller_cannot_read(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        mine = fixtures.project()
        private = fixtures.project()
        visible, _ = fixtures.document(mine, "Webhook retries", "Stripe webhook retries.")
        secret, _ = fixtures.document(
            private, "Webhook retries (private)", "Stripe webhook retries in the secret project."
        )
        for doc in (visible, secret):
            index(rag_client, doc)

        results = search(rag_client, "stripe webhook retries secret project", [mine])

        assert [r["documentId"] for r in results] == [str(visible)]
        assert search(rag_client, "stripe webhook retries", []) == []

    def test_one_result_per_document_and_source_type_filter(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, _ = fixtures.document(project, "Runbook", RUNBOOK, source_type="UPLOAD")
        issue, _ = fixtures.document(project, "Reconciliation slow", "Reconciliation times out.")
        index(rag_client, doc)
        index(rag_client, issue)

        results = search(rag_client, "reconciliation webhook", [project])
        uploads = search(rag_client, "reconciliation", [project], sourceTypes=["UPLOAD"])

        ids = [r["documentId"] for r in results]
        assert len(ids) == len(set(ids)) == 2
        assert [r["documentId"] for r in uploads] == [str(doc)]


class TestRelated:
    def test_related_issues_reuse_the_stored_vector_and_exclude_the_issue_itself(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        other_project = fixtures.project()
        target, target_issue = fixtures.document(
            project, "Stripe webhook retries double-charge", "Duplicate charges on retry."
        )
        similar, similar_issue = fixtures.document(
            project, "Stripe webhook retries send two receipts", "Duplicate receipts on retry."
        )
        unrelated, _ = fixtures.document(project, "Dark mode", "Add a dark colour theme.")
        elsewhere, _ = fixtures.document(
            other_project, "Stripe webhook retries double-charge", "Duplicate charges on retry."
        )
        for doc in (target, similar, unrelated, elsewhere):
            index(rag_client, doc)

        response = rag_client.post(
            "/v1/related",
            json={"projectId": str(project), "issueId": str(target_issue)},
            headers=AUTH,
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert [r["issueId"] for r in body["results"]] == [str(similar_issue)]
        assert body["results"][0]["score"] >= body["threshold"]
        assert body["embedding"]["inputTokens"] == 0  # stored vector reused

    def test_related_issues_for_draft_text(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, issue = fixtures.document(
            project, "Refund endpoint returns 500", "Refunding a partially captured payment fails."
        )
        index(rag_client, doc)

        response = rag_client.post(
            "/v1/related",
            json={"projectId": str(project), "text": "refund endpoint 500 partially captured"},
            headers=AUTH,
        )

        body = response.json()
        assert [r["issueId"] for r in body["results"]] == [str(issue)]
        assert body["embedding"]["inputTokens"] > 0

    def test_nothing_above_the_threshold_returns_nothing(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, _ = fixtures.document(project, "Dark mode", "Add a dark colour theme.")
        index(rag_client, doc)

        response = rag_client.post(
            "/v1/related",
            json={"projectId": str(project), "text": "database connection pool exhausted"},
            headers=AUTH,
        )

        assert response.json()["results"] == []


class TestChat:
    PROJECT_KEY = "PAY"

    def chat(self, client: TestClient, project: uuid.UUID, **body: Any) -> list[Any]:
        payload = {
            "messages": [{"role": "user", "content": "Why were customers charged twice?"}],
            "projects": [{"id": str(project), "key": self.PROJECT_KEY, "name": "Payments"}],
            **body,
        }
        response = client.post("/v1/chat", json=payload, headers=AUTH)
        assert response.status_code == 200, response.text
        return events(response.text)

    def test_answers_with_citations_to_retrieved_sources(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        doc, issue = fixtures.document(
            project,
            "PAY-1: Stripe webhook retries can double-charge customers",
            "Customers were charged twice because the webhook handler was not idempotent.",
            url="/projects/PAY/issues/PAY-1",
        )
        index(rag_client, doc)

        streamed = self.chat(rag_client, project)

        kinds = [kind for kind, _ in streamed]
        assert kinds[-1] == "result"
        assert "delta" in kinds
        result = streamed[-1][1]
        assert "[1]" in result["answer"]
        assert result["citations"] == [
            {
                "n": 1,
                "sourceType": "ISSUE",
                "sourceId": str(issue),
                "documentId": str(doc),
                "projectId": str(project),
                "title": "PAY-1: Stripe webhook retries can double-charge customers",
                "url": "/projects/PAY/issues/PAY-1",
                "headingPath": None,
            }
        ]
        assert result["promptVersion"] == "chat_answer@1"
        assert result["embedding"]["inputTokens"] > 0

    def test_says_it_does_not_know_without_matching_sources(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        result = self.chat(rag_client, project)[-1][1]
        assert result["answer"].startswith("I don't know")
        assert result["citations"] == []

    def test_listing_questions_call_query_issues_then_answer_from_its_results(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        question = [{"role": "user", "content": "Which bugs were fixed last sprint?"}]

        first = self.chat(rag_client, project, messages=question)

        kind, call = first[-1]
        assert kind == "tool_call"
        assert call["name"] == "query_issues"
        assert call["arguments"] == {
            "project_key": "PAY",
            "type": "BUG",
            "status": "done",
            "priority": None,
            "sprint": "last_completed",
            "updated_within_days": None,
        }

        issue_id = uuid.uuid4()
        second = self.chat(
            rag_client,
            project,
            messages=question,
            toolCall={"id": call["id"], "name": call["name"], "arguments": call["rawArguments"]},
            toolResult={
                "total": 1,
                "issues": [
                    {
                        "id": str(issue_id),
                        "projectId": str(project),
                        "key": "PAY-3",
                        "title": "Refund endpoint returns 500",
                        "type": "BUG",
                        "status": "DONE",
                        "priority": "HIGH",
                        "assignee": "Mei Tanaka",
                        "updatedAt": "2026-09-20T10:00:00Z",
                        "url": "/projects/PAY/issues/PAY-3",
                    }
                ],
            },
        )

        kind, result = second[-1]
        assert kind == "result"
        assert "PAY-3" in result["answer"]
        assert [c["sourceId"] for c in result["citations"]] == [str(issue_id)]

    def test_a_tool_result_without_its_call_is_rejected(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        project = fixtures.project()
        response = rag_client.post(
            "/v1/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "projects": [{"id": str(project), "key": "PAY", "name": "Payments"}],
                "toolResult": {"total": 0, "issues": []},
            },
            headers=AUTH,
        )
        assert response.status_code == 422

    def test_chat_retrieval_is_limited_to_the_given_projects(
        self, rag_client: TestClient, fixtures: Fixtures
    ) -> None:
        mine = fixtures.project()
        private = fixtures.project()
        doc, _ = fixtures.document(
            private, "Customers charged twice", "Customers were charged twice (private project)."
        )
        index(rag_client, doc)

        result = self.chat(rag_client, mine)[-1][1]

        assert result["citations"] == []
        assert "private" not in result["answer"]


class TestLeastPrivilege:
    def test_the_service_role_cannot_read_anything_but_the_rag_tables(
        self, test_database: ScratchDatabase
    ) -> None:
        with psycopg.connect(test_database.service_url) as conn:
            conn.execute("SELECT count(*) FROM document_chunks")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                conn.execute("SELECT count(*) FROM users")


def test_retrieval_answers_503_when_not_configured(client: TestClient) -> None:
    response = client.post("/v1/search", json={"query": "x", "projectIds": []}, headers=AUTH)
    assert response.status_code == 503
    assert "AI_DATABASE_URL" in response.json()["detail"]


def normalise_ids(value: Any) -> Any:
    """Replaces UUIDs with stable placeholders (in order of first appearance), so the recorded
    contract does not change from run to run."""
    text = json.dumps(value)
    seen: dict[str, str] = {}
    for found in re.findall(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", text):
        seen.setdefault(found, f"00000000-0000-4000-8000-{len(seen) + 1:012d}")
    for original, placeholder in seen.items():
        text = text.replace(original, placeholder)
    return json.loads(text)


def test_response_shapes_match_the_recorded_contract(
    rag_client: TestClient, fixtures: Fixtures
) -> None:
    """Golden files the API's Zod schemas parse (ADR-0013): both sides change together."""
    project = fixtures.project()
    doc, issue = fixtures.document(
        project,
        "PAY-1: Stripe webhook retries can double-charge customers",
        "Issue PAY-1: Stripe webhook retries can double-charge customers\n\n"
        "Customers were charged twice because the webhook handler was not idempotent.",
        url="/projects/PAY/issues/PAY-1",
    )
    other, _ = fixtures.document(
        project,
        "PAY-2: Stripe webhook retries send duplicate receipts",
        "Issue PAY-2: Stripe webhook retries send duplicate receipts\n\nTwo receipts.",
        url="/projects/PAY/issues/PAY-2",
    )
    check_contract("index_response", normalise_ids(index(rag_client, doc)))
    index(rag_client, other)

    searched = rag_client.post(
        "/v1/search", json={"query": "charged twice", "projectIds": [str(project)]}, headers=AUTH
    )
    check_contract("search_response", normalise_ids(searched.json()))

    related = rag_client.post(
        "/v1/related", json={"projectId": str(project), "issueId": str(issue)}, headers=AUTH
    )
    check_contract("related_response", normalise_ids(related.json()))

    projects = [{"id": str(project), "key": "PAY", "name": "Payments"}]
    answered = rag_client.post(
        "/v1/chat",
        json={
            "messages": [{"role": "user", "content": "Why were customers charged twice?"}],
            "projects": projects,
        },
        headers=AUTH,
    )
    check_contract("chat_result_event", normalise_ids(events(answered.text)[-1][1]))

    listed = rag_client.post(
        "/v1/chat",
        json={
            "messages": [{"role": "user", "content": "Which bugs are open?"}],
            "projects": projects,
        },
        headers=AUTH,
    )
    check_contract("chat_tool_call_event", normalise_ids(events(listed.text)[-1][1]))
