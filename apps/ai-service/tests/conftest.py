from collections.abc import AsyncIterator, Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg_pool import AsyncConnectionPool
from pydantic import SecretStr

from app.core.config import Settings, get_settings
from app.main import create_app
from app.rag.store import Store
from tests.db import Fixtures, ScratchDatabase, admin_url, create_database, drop_database

TEST_TOKEN = "test-service-token-0123456789abcdef"
AUTH = {"Authorization": f"Bearer {TEST_TOKEN}"}


@pytest.fixture
def settings() -> Settings:
    return Settings(
        environment="test",
        log_json=False,
        service_token=SecretStr(TEST_TOKEN),
        # Explicitly off: a developer's .env must not point unit tests at a real database.
        database_url=None,
        # Each test app would otherwise start a metrics server on the same port.
        metrics_port=0,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    app = create_app(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    with TestClient(app) as test_client:
        yield test_client


# ---------------------------------------------------------------- database tests


@pytest.fixture(scope="session")
def test_database() -> Iterator[ScratchDatabase]:
    server = admin_url()
    if server is None:
        pytest.skip("TEST_DATABASE_ADMIN_URL is not set")
    database = create_database(server)
    yield database
    drop_database(server, database)


@pytest.fixture
def admin(test_database: ScratchDatabase) -> Iterator[psycopg.Connection[Any]]:
    with psycopg.connect(test_database.admin_url, autocommit=True) as conn:
        yield conn


@pytest.fixture
def fixtures(admin: psycopg.Connection[Any]) -> Fixtures:
    return Fixtures(admin)


@pytest.fixture
def db_settings(test_database: ScratchDatabase) -> Settings:
    return Settings(
        environment="test",
        log_json=False,
        service_token=SecretStr(TEST_TOKEN),
        database_url=SecretStr(test_database.service_url),
        metrics_port=0,
    )


@pytest.fixture
def rag_client(db_settings: Settings) -> Iterator[TestClient]:
    app = create_app(db_settings)
    app.dependency_overrides[get_settings] = lambda: db_settings
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
async def store(test_database: ScratchDatabase) -> AsyncIterator[Store]:
    """The store as the service uses it, for tests below the HTTP layer."""
    async with AsyncConnectionPool(test_database.service_url, min_size=1, open=False) as pool:
        yield Store(pool)
