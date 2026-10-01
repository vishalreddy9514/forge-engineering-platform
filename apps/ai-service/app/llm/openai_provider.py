"""OpenAI Chat Completions with strict structured outputs, streamed."""

from collections.abc import AsyncIterator

import openai
from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionMessageParam
from openai.types.shared_params import ResponseFormatJSONSchema

from app.llm.base import (
    Completion,
    Message,
    OutputSchema,
    ProviderError,
    StreamEvent,
    TextDelta,
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
        except openai.RateLimitError as error:
            raise ProviderError(f"OpenAI rate limit: {error.message}", retryable=True) from error
        except (openai.APITimeoutError, openai.APIConnectionError) as error:
            raise ProviderError(f"OpenAI unreachable: {error}", retryable=True) from error
        except openai.APIStatusError as error:
            raise ProviderError(
                f"OpenAI error {error.status_code}: {error.message}",
                retryable=error.status_code >= 500,
            ) from error

        yield Completion(text="".join(parts), model=model, usage=usage or Usage(0, 0))


def _to_openai(message: Message) -> ChatCompletionMessageParam:
    if message["role"] == "system":
        return {"role": "system", "content": message["content"]}
    if message["role"] == "assistant":
        return {"role": "assistant", "content": message["content"]}
    return {"role": "user", "content": message["content"]}
