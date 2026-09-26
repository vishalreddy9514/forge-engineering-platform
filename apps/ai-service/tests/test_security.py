import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from tests.conftest import TEST_TOKEN


def test_accepts_the_service_token(client: TestClient) -> None:
    response = client.get("/v1/whoami", headers={"Authorization": f"Bearer {TEST_TOKEN}"})
    assert response.status_code == 200
    assert response.json()["caller"] == "internal-service"


@pytest.mark.parametrize(
    "headers",
    [
        {},
        {"Authorization": "Bearer wrong-token"},
        {"Authorization": f"Basic {TEST_TOKEN}"},
        {"Authorization": f"Bearer {TEST_TOKEN}x"},
    ],
    ids=["missing", "wrong", "wrong-scheme", "token-prefix-only"],
)
def test_rejects_missing_or_invalid_tokens(client: TestClient, headers: dict[str, str]) -> None:
    response = client.get("/v1/whoami", headers=headers)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


def test_settings_reject_a_short_service_token() -> None:
    with pytest.raises(ValidationError, match=r"service_token|AI_SERVICE_TOKEN"):
        Settings(service_token=SecretStr("changeme"))
