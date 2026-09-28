from fastapi import FastAPI

from app.api import health, v1
from app.core.config import Settings, get_settings
from app.core.logging import configure_logging
from app.core.request_context import RequestContextMiddleware
from app.llm.factory import build_provider


def create_app(settings: Settings | None = None) -> FastAPI:
    """Application factory (run with `uvicorn app.main:create_app --factory`).

    A factory rather than a module-level app keeps imports side-effect free, so tests can
    build the app with explicit settings instead of depending on the process environment.
    """
    settings = settings or get_settings()
    configure_logging(settings.log_level, settings.log_json)

    is_production = settings.environment == "production"
    app = FastAPI(
        title="Forge AI service",
        version="0.0.0",
        # Internal service: no public docs in production.
        docs_url=None if is_production else "/docs",
        redoc_url=None,
        openapi_url=None if is_production else "/openapi.json",
    )
    app.state.settings = settings
    app.state.provider = build_provider(settings)
    app.add_middleware(RequestContextMiddleware)
    app.include_router(health.router)
    app.include_router(v1.router)
    return app
