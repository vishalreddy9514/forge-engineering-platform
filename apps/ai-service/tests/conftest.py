from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.core.config import Settings, get_settings
from app.main import create_app

TEST_TOKEN = "test-service-token-0123456789abcdef"


@pytest.fixture
def settings() -> Settings:
    return Settings(
        environment="test",
        log_json=False,
        service_token=SecretStr(TEST_TOKEN),
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as test_client:
        yield test_client
