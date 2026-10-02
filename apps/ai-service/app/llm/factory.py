from openai import AsyncOpenAI

from app.core.config import Settings
from app.llm.base import ChatProvider
from app.llm.fake import FakeChatProvider
from app.llm.openai_provider import OpenAIChatProvider
from app.rag.embedder import EmbeddingProvider, FakeEmbedder, OpenAIEmbedder


def _openai_client(settings: Settings) -> AsyncOpenAI:
    if settings.openai_api_key is None:  # also rejected by Settings validation
        raise ValueError("OPENAI_API_KEY is required when AI_PROVIDER=openai")
    return AsyncOpenAI(
        api_key=settings.openai_api_key.get_secret_value(),
        base_url=settings.openai_base_url,
        timeout=settings.request_timeout_seconds,
        # Retries belong to the caller (the API's job queue), not hidden inside one request.
        max_retries=0,
    )


def build_provider(settings: Settings) -> ChatProvider:
    """Built once per process in create_app, so the HTTP connection pool is reused."""
    if settings.provider == "fake":
        return FakeChatProvider()
    return OpenAIChatProvider(_openai_client(settings), settings.openai_chat_model)


def build_embedder(settings: Settings) -> EmbeddingProvider:
    if settings.provider == "fake":
        return FakeEmbedder()
    return OpenAIEmbedder(_openai_client(settings), settings.openai_embedding_model)
