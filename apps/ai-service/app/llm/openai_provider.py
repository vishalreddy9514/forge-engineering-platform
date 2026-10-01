"""OpenAI Chat Completions with strict structured outputs, streamed."""

from collections.abc import AsyncIterator, Sequence

import openai
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionFunctionToolParam, ChatCompletionMessageParam
from openai.types.shared_params import ResponseFormatJSONSchema

from app.llm.base import (
    ChatEvent,
    ChatMessage,
    Completion,
    Message,
    OutputSchema,
    ProviderError,
    StreamEvent,
    TextDelta,
    Tool,
    ToolCall,
    Usage,
)


class OpenAIChatProvider:
    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self.model = model

    async def stream(
        self, messages: list[Message], schema: OutputSchema, max_output_tokens: int
    ) -> AsyncIterator[StreamEvent]:
        # Strict mode: the model can only produce JSON matching the schema.
        response_format: ResponseFormatJSONSchema = {
            "type": "json_schema",
            "json_schema": {"name": schema.name, "strict": True, "schema": schema.schema},
        }
        try:
            chunks = await self._client.chat.completions.create(
                model=self.model,
                messages=[_to_openai(m) for m in messages],
                response_format=response_format,
                max_completion_tokens=max_output_tokens,
                stream=True,
                # The final chunk then carries token usage, which is what cost tracking needs.
                stream_options={"include_usage": True},
            )
            parts: list[str] = []
            model = self.model
            usage: Usage | None = None
            async for chunk in chunks:
                model = chunk.model or model
                if chunk.usage is not None:
                    usage = Usage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
                for choice in chunk.choices:
                    if choice.delta.content:
                        parts.append(choice.delta.content)
                        yield TextDelta(choice.delta.content)
                    if choice.finish_reason == "length":
                        raise ProviderError(
                            "The response was cut off at the output token limit", retryable=False
                        )
                    if getattr(choice.delta, "refusal", None):
                        raise ProviderError("The model declined the request", retryable=False)
        except openai.OpenAIError as error:
            raise provider_error(error) from error

        yield Completion(text="".join(parts), model=model, usage=usage or Usage(0, 0))

    async def stream_chat(
        self, messages: Sequence[ChatMessage], tools: list[Tool], max_output_tokens: int
    ) -> AsyncIterator[ChatEvent]:
        tool_params: list[ChatCompletionFunctionToolParam] = [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                    "strict": True,
                },
            }
            for tool in tools
        ]
        try:
            chunks = await self._client.chat.completions.create(
                model=self.model,
                messages=[_chat_to_openai(m) for m in messages],
                max_completion_tokens=max_output_tokens,
                stream=True,
                stream_options={"include_usage": True},
                tools=tool_params or openai.omit,
                parallel_tool_calls=False if tool_params else openai.omit,
            )
            parts: list[str] = []
            model = self.model
            usage: Usage | None = None
            call_id = call_name = ""
            call_arguments: list[str] = []
            async for chunk in chunks:
                model = chunk.model or model
                if chunk.usage is not None:
                    usage = Usage(chunk.usage.prompt_tokens, chunk.usage.completion_tokens)
                for choice in chunk.choices:
                    if choice.delta.content:
                        parts.append(choice.delta.content)
                        yield TextDelta(choice.delta.content)
                    # Tool calls arrive in pieces: the ID and name first, then the arguments.
                    for call in choice.delta.tool_calls or []:
                        if call.index != 0:
                            continue  # parallel calls are disabled; ignore anything past one
                        call_id = call.id or call_id
                        if call.function is not None:
                            call_name = call.function.name or call_name
                            call_arguments.append(call.function.arguments or "")
                    if choice.finish_reason == "length":
                        raise ProviderError(
                            "The response was cut off at the output token limit", retryable=False
                        )
        except openai.OpenAIError as error:
            raise provider_error(error) from error

        if call_name:
            yield ToolCall(call_id, call_name, "".join(call_arguments))
            yield Completion(text="", model=model, usage=usage or Usage(0, 0))
            return
        yield Completion(text="".join(parts), model=model, usage=usage or Usage(0, 0))


def provider_error(error: openai.OpenAIError) -> ProviderError:
    """Maps SDK errors to the provider-neutral error: rate limits, timeouts and 5xx may succeed
    on a later attempt; anything else (bad request, auth) will not."""
    if isinstance(error, openai.RateLimitError):
        return ProviderError(f"OpenAI rate limit: {error.message}", retryable=True)
    if isinstance(error, openai.APITimeoutError | openai.APIConnectionError):
        return ProviderError(f"OpenAI unreachable: {error}", retryable=True)
    if isinstance(error, openai.APIStatusError):
        return ProviderError(
            f"OpenAI error {error.status_code}: {error.message}",
            retryable=error.status_code >= 500,
        )
    return ProviderError(f"OpenAI client error: {error}", retryable=False)


def _chat_to_openai(message: ChatMessage) -> ChatCompletionMessageParam:
    if message["role"] == "tool_call":
        call = message["call"]
        return {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": call.id,
                    "type": "function",
                    "function": {"name": call.name, "arguments": call.arguments},
                }
            ],
        }
    if message["role"] == "tool":
        return {"role": "tool", "tool_call_id": message["call_id"], "content": message["content"]}
    return _to_openai(message)


def _to_openai(message: Message) -> ChatCompletionMessageParam:
    if message["role"] == "system":
        return {"role": "system", "content": message["content"]}
    if message["role"] == "assistant":
        return {"role": "assistant", "content": message["content"]}
    return {"role": "user", "content": message["content"]}
