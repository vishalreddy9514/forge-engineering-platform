from functools import lru_cache
from typing import Literal

from pydantic import Field, SecretStr
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
    # Shared secret the API and worker send as a bearer token. Minimum length keeps
    # accidental placeholder values like "changeme" out of any environment.
    service_token: SecretStr = Field(min_length=32, validation_alias="AI_SERVICE_TOKEN")


@lru_cache
def get_settings() -> Settings:
    return Settings()  # values come from the environment
