from fastapi.testclient import TestClient


def test_live_needs_no_auth(client: TestClient) -> None:
    response = client.get("/health/live")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_ready_needs_no_auth(client: TestClient) -> None:
    response = client.get("/health/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "provider": "fake", "model": "fake"}
