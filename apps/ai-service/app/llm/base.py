"""Model-provider interface. Features depend on this, never on a vendor SDK directly."""

from collections.abc import AsyncIterator, Sequence
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


@dataclass(frozen=True)
class Tool:
    """A function the model may call (strict JSON Schema for its arguments)."""

    name: str
    description: str
    parameters: dict[str, Any]


@dataclass(frozen=True)
class ToolCall:
    """The model asked for a tool. `arguments` is the JSON text it produced, not yet trusted."""

    id: str
    name: str
    arguments: str


class ToolCallTurn(TypedDict):
    """An earlier turn in which the assistant called a tool."""

    role: Literal["tool_call"]
    call: ToolCall


class ToolResultTurn(TypedDict):
    role: Literal["tool"]
    call_id: str
    content: str


ChatMessage = Message | ToolCallTurn | ToolResultTurn
ChatEvent = TextDelta | ToolCall | Completion


class ChatProvider(Protocol):
    model: str

    def stream(
        self, messages: list[Message], schema: OutputSchema, max_output_tokens: int
    ) -> AsyncIterator[StreamEvent]:
        """Streams a completion constrained to `schema`. The last event is always a Completion."""
        ...

    def stream_chat(
        self, messages: Sequence[ChatMessage], tools: list[Tool], max_output_tokens: int
    ) -> AsyncIterator[ChatEvent]:
        """Streams free text, or at most one ToolCall when `tools` are offered. The last event
        is always a Completion (with empty text after a tool call)."""
        ...


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
