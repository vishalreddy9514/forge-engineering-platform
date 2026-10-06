from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Environment configuration, validated at startup (fails fast on bad values)."""

    model_config = SettingsConfigDict(
        # Service-local overrides first, then the monorepo root .env shared with docker compose.
        env_file=(".env", "../../.env"),
        env_file_encoding="utf-8",
        extra="ignore",
        # Allow Settings(service_token=...) in tests as well as the env-var aliases.
        populate_by_name=True,
    )

    environment: Literal["development", "test", "production"] = Field(
        default="development", validation_alias="NODE_ENV"
    )
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = Field(
        default="INFO", validation_alias="AI_LOG_LEVEL"
    )
    log_json: bool = Field(default=True, validation_alias="AI_LOG_JSON")
    # Prometheus metrics on a port of their own, never routed by the proxy; 0 turns it off.
    metrics_port: int = Field(default=9464, ge=0, le=65535, validation_alias="METRICS_PORT")
    # Error reporting (app/core/errors.py); unset turns it off.
    sentry_dsn: SecretStr | None = Field(default=None, validation_alias="SENTRY_DSN")
    sentry_environment: str | None = Field(default=None, validation_alias="SENTRY_ENVIRONMENT")
    sentry_release: str | None = Field(default=None, validation_alias="SENTRY_RELEASE")
    # Shared secret the API and worker send as a bearer token. Minimum length keeps
    # accidental placeholder values like "changeme" out of any environment.
    service_token: SecretStr = Field(min_length=32, validation_alias="AI_SERVICE_TOKEN")

    # ---- Model provider (architecture §7.1) ----
    # "fake" is deterministic and needs no key: local development and every test use it, so no
    # test ever calls OpenAI. Deployed environments set "openai" and a key from SSM.
    provider: Literal["openai", "fake"] = Field(default="fake", validation_alias="AI_PROVIDER")
    openai_api_key: SecretStr | None = Field(default=None, validation_alias="OPENAI_API_KEY")
    # Model names are configuration, not code.
    openai_chat_model: str = Field(default="gpt-4.1-mini", validation_alias="OPENAI_CHAT_MODEL")
    # Tests point this at a mock transport; unset means api.openai.com.
    openai_base_url: str | None = Field(default=None, validation_alias="OPENAI_BASE_URL")
    request_timeout_seconds: float = Field(
        default=60, gt=0, le=300, validation_alias="AI_REQUEST_TIMEOUT_SECONDS"
    )
    # Upper bound on the prompt one request may send (OWASP LLM "unbounded consumption").
    max_input_tokens: int = Field(
        default=12_000, ge=1_000, le=200_000, validation_alias="AI_MAX_INPUT_TOKENS"
    )

    openai_embedding_model: str = Field(
        default="text-embedding-3-small", validation_alias="OPENAI_EMBEDDING_MODEL"
    )

    # ---- Retrieval (architecture §7.2) ----
    # Login for the least-privilege `forge_ai` role (ADR-0004). Unset disables retrieval: the
    # RAG endpoints answer 503 and drafts and summaries keep working.
    database_url: SecretStr | None = Field(default=None, validation_alias="AI_DATABASE_URL")
    db_pool_max_size: int = Field(default=10, ge=1, le=100, validation_alias="AI_DB_POOL_MAX")
    # Overrides the embedding model's own related-issues threshold (FR-7.3).
    related_min_score: float | None = Field(
        default=None, ge=0, le=1, validation_alias="RELATED_MIN_SCORE"
    )

    @model_validator(mode="after")
    def _openai_needs_a_key(self) -> "Settings":
        if self.provider == "openai" and self.openai_api_key is None:
            raise ValueError("OPENAI_API_KEY is required when AI_PROVIDER=openai")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()  # values come from the environment
