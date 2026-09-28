"""Model-provider interface. Features depend on this, never on a vendor SDK directly."""

from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict


class Message(TypedDict):
    role: Literal["system", "user", "assistant"]
    content: str


@dataclass(frozen=True)
class OutputSchema:
    """A JSON Schema the model's output must match (OpenAI structured outputs)."""

    name: str
    schema: dict[str, Any]


@dataclass(frozen=True)
class Usage:
    input_tokens: int
    output_tokens: int

    def __add__(self, other: "Usage") -> "Usage":
        return Usage(
            self.input_tokens + other.input_tokens, self.output_tokens + other.output_tokens
        )


@dataclass(frozen=True)
class TextDelta:
    """A piece of the model's output as it is generated."""

    text: str


@dataclass(frozen=True)
class Completion:
    """The end of a stream: the full output and what it cost."""

    text: str
    model: str
    usage: Usage


StreamEvent = TextDelta | Completion


class ChatProvider(Protocol):
    """Streams a completion constrained to `schema`. The last event is always a Completion."""

    model: str

    def stream(
        self, messages: list[Message], schema: OutputSchema, max_output_tokens: int
    ) -> AsyncIterator[StreamEvent]: ...


class ProviderError(Exception):
    """The provider failed. `retryable` errors (rate limits, timeouts, 5xx) may succeed later."""

    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable


async def complete(
    provider: ChatProvider, messages: list[Message], schema: OutputSchema, max_output_tokens: int
) -> Completion:
    """Runs a stream to the end and returns its Completion (for callers that do not stream)."""
    async for event in provider.stream(messages, schema, max_output_tokens):
        if isinstance(event, Completion):
            return event
    raise ProviderError("The provider ended the stream without a completion", retryable=True)
