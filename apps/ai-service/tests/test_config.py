import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from app.llm.factory import build_provider
from app.llm.fake import FakeChatProvider
from app.llm.metered import MeteredChatProvider
from app.llm.openai_provider import OpenAIChatProvider
from tests.conftest import TEST_TOKEN


def test_the_fake_provider_is_the_default_and_needs_no_key() -> None:
    settings = Settings(service_token=SecretStr(TEST_TOKEN))
    assert settings.provider == "fake"
    provider = build_provider(settings)
    # Every provider is wrapped so its calls are metered (app/llm/metered.py).
    assert isinstance(provider, MeteredChatProvider)
    assert isinstance(provider.inner, FakeChatProvider)


def test_openai_requires_a_key() -> None:
    with pytest.raises(ValidationError, match="OPENAI_API_KEY"):
        Settings(service_token=SecretStr(TEST_TOKEN), provider="openai")


def test_openai_uses_the_configured_model() -> None:
    settings = Settings(
        service_token=SecretStr(TEST_TOKEN),
        provider="openai",
        openai_api_key=SecretStr("sk-test"),
        openai_chat_model="gpt-4.1-nano",
    )
    provider = build_provider(settings)
    assert isinstance(provider, MeteredChatProvider)
    assert isinstance(provider.inner, OpenAIChatProvider)
    assert provider.model == "gpt-4.1-nano"
