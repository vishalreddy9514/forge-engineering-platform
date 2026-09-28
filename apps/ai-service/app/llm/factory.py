from openai import AsyncOpenAI

from app.core.config import Settings
from app.llm.base import ChatProvider
from app.llm.fake import FakeChatProvider
from app.llm.openai_provider import OpenAIChatProvider


def build_provider(settings: Settings) -> ChatProvider:
    """Built once per process in create_app, so the HTTP connection pool is reused."""
    if settings.provider == "fake":
        return FakeChatProvider()
    if settings.openai_api_key is None:  # also rejected by Settings validation
        raise ValueError("OPENAI_API_KEY is required when AI_PROVIDER=openai")
    client = AsyncOpenAI(
        api_key=settings.openai_api_key.get_secret_value(),
        base_url=settings.openai_base_url,
        timeout=settings.request_timeout_seconds,
        # Retries belong to the caller (the API's job queue), not hidden inside one request.
        max_retries=0,
    )
    return OpenAIChatProvider(client, settings.openai_chat_model)
