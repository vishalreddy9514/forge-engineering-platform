from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import psycopg
from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse
from psycopg_pool import AsyncConnectionPool, PoolTimeout

from app.api import health, v1
from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from app.core.request_context import RequestContextMiddleware
from app.llm.factory import build_embedder, build_provider
from app.rag.store import Store


def create_app(settings: Settings | None = None) -> FastAPI:
    """Application factory (run with `uvicorn app.main:create_app --factory`).

    A factory rather than a module-level app keeps imports side-effect free, so tests can
    build the app with explicit settings instead of depending on the process environment.
    """
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    is_production = settings.environment == "production"

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if settings.database_url is None:
            app.state.store = None
            yield
            return
        pool: AsyncConnectionPool[psycopg.AsyncConnection[object]] = AsyncConnectionPool(
            settings.database_url.get_secret_value(),
            min_size=1,
            max_size=settings.db_pool_max_size,
            # Waiting longer than this for a connection is an outage, not a slow query.
            timeout=10,
            kwargs={"application_name": "forge-ai-service"},
            open=False,
        )
        # Not waiting: a database that is still starting must not stop the service from
        # serving drafts and summaries; retrieval requests answer 503 until it is reachable.
        await pool.open(wait=False)
        app.state.store = Store(pool)
        try:
            yield
        finally:
            await pool.close()

    app = FastAPI(
        title="Forge AI service",
        lifespan=lifespan,
        version="0.0.0",
        # Internal service: no public docs in production.
        docs_url=None if is_production else "/docs",
        redoc_url=None,
        openapi_url=None if is_production else "/openapi.json",
    )
    app.state.settings = settings
    app.state.provider = build_provider(settings)
    app.state.embedder = build_embedder(settings)
    app.add_exception_handler(psycopg.OperationalError, _store_unavailable)
    app.add_exception_handler(PoolTimeout, _store_unavailable)
    app.add_middleware(RequestContextMiddleware)
    app.include_router(health.router)
    app.include_router(v1.router)
    return app


async def _store_unavailable(request: Request, error: Exception) -> JSONResponse:
    """The database is unreachable or saturated: retryable, so 503 like a provider outage."""
    return JSONResponse(
        {"detail": "The retrieval store is unavailable"},
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
    )
