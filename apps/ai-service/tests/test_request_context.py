import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.core.request_context import resolve_request_id
from app.main import create_app
from tests.conftest import TEST_TOKEN


def test_propagates_a_safe_incoming_request_id(client: TestClient) -> None:
    response = client.get(
        "/v1/whoami",
        headers={"Authorization": f"Bearer {TEST_TOKEN}", "x-request-id": "abc-123"},
    )
    assert response.headers["x-request-id"] == "abc-123"
    assert response.json()["request_id"] == "abc-123"


def test_generates_a_request_id_when_missing(client: TestClient) -> None:
    response = client.get("/health/live")
    assert len(response.headers["x-request-id"]) == 36


@pytest.mark.parametrize("value", ["has space", "new\nline", "x" * 129, ""])
def test_replaces_unsafe_request_ids(value: str) -> None:
    assert resolve_request_id(value) != value


def test_docs_are_served_outside_production(client: TestClient) -> None:
    assert client.get("/openapi.json").status_code == 200


def test_docs_are_disabled_in_production(settings: Settings) -> None:
    production = settings.model_copy(update={"environment": "production"})
    with TestClient(create_app(production)) as client:
        assert client.get("/openapi.json").status_code == 404
        assert client.get("/docs").status_code == 404
