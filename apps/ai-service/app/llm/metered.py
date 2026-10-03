"""Provider wrappers that record every model call: latency, tokens, cost and outcome.

Wrapping at the provider means every feature (drafts, summaries, reviews, chat, retrieval) is
measured the same way without each one remembering to.
"""

import time
from collections.abc import AsyncIterator, Sequence

from app.core.metrics import LLM_COST, LLM_DURATION, LLM_TOKENS, current_feature
from app.llm.base import (
    ChatEvent,
    ChatMessage,
    ChatProvider,
    Completion,
    Message,
    OutputSchema,
    ProviderError,
    StreamEvent,
    Tool,
    Usage,
)
from app.llm.pricing import estimate_cost
from app.rag.embedder import EmbeddingProvider, Embeddings


def _outcome(error: BaseException) -> str:
    if isinstance(error, ProviderError):
        return "error_retryable" if error.retryable else "error_permanent"
    if isinstance(error, GeneratorExit):
        return "cancelled"  # the client went away mid-stream
    return "error"


def _record_usage(feature: str, model: str, usage: Usage) -> None:
    LLM_TOKENS.labels(feature=feature, model=model, direction="input").inc(usage.input_tokens)
    LLM_TOKENS.labels(feature=feature, model=model, direction="output").inc(usage.output_tokens)
    LLM_COST.labels(feature=feature, model=model).inc(float(estimate_cost(model, usage)))


class MeteredChatProvider:
    def __init__(self, inner: ChatProvider) -> None:
        self.inner = inner
        self.model = inner.model

    def stream(
        self, messages: list[Message], schema: OutputSchema, max_output_tokens: int
    ) -> AsyncIterator[StreamEvent]:
        return self._metered("structured", self.inner.stream(messages, schema, max_output_tokens))

    def stream_chat(
        self, messages: Sequence[ChatMessage], tools: list[Tool], max_output_tokens: int
    ) -> AsyncIterator[ChatEvent]:
        return self._metered("chat", self.inner.stream_chat(messages, tools, max_output_tokens))

    async def _metered[E](self, operation: str, events: AsyncIterator[E]) -> AsyncIterator[E]:
        feature = current_feature.get()
        started = time.perf_counter()
        model = self.model
        outcome = "ok"
        try:
            async for event in events:
                if isinstance(event, Completion):
                    model = event.model
                    _record_usage(feature, model, event.usage)
                yield event
        except BaseException as error:
            outcome = _outcome(error)
            raise
        finally:
            LLM_DURATION.labels(
                feature=feature, operation=operation, model=model, outcome=outcome
            ).observe(time.perf_counter() - started)


class MeteredEmbedder:
    def __init__(self, inner: EmbeddingProvider) -> None:
        self.inner = inner
        self.model = inner.model
        self.related_threshold = inner.related_threshold

    async def embed(self, texts: list[str]) -> Embeddings:
        feature = current_feature.get()
        started = time.perf_counter()
        model = self.model
        outcome = "ok"
        try:
            embeddings = await self.inner.embed(texts)
            model = embeddings.model
            _record_usage(feature, model, Usage(embeddings.input_tokens, 0))
            return embeddings
        except BaseException as error:
            outcome = _outcome(error)
            raise
        finally:
            LLM_DURATION.labels(
                feature=feature, operation="embedding", model=model, outcome=outcome
            ).observe(time.perf_counter() - started)
