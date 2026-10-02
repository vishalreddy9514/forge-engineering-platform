"""The OpenAI provider against a mock HTTP transport: request shape, streaming, usage, errors."""

import json
from collections.abc import Callable
from typing import Any

import httpx2 as httpx  # the OpenAI SDK's HTTP client
import pytest
from openai import AsyncOpenAI

from app.features.drafts import DRAFT_SCHEMA
from app.llm.base import (
    ChatMessage,
    Completion,
    Message,
    ProviderError,
    TextDelta,
    Tool,
    ToolCall,
    Usage,
)
from app.llm.openai_provider import OpenAIChatProvider

MESSAGES: list[Message] = [
    {"role": "system", "content": "rules"},
    {"role": "user", "content": "text"},
]


def chunk(content: str | None = None, finish: str | None = None, usage: Any = None) -> str:
    body: dict[str, Any] = {
        "id": "chatcmpl-1",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "gpt-4.1-mini-2025-04-14",
        "choices": []
        if usage
        else [
            {
                "index": 0,
                "delta": {"content": content} if content is not None else {},
                "finish_reason": finish,
            }
        ],
    }
    if usage:
        body["usage"] = usage
    return f"data: {json.dumps(body)}\n\n"


def provider_for(handler: Callable[[httpx.Request], httpx.Response]) -> OpenAIChatProvider:
    client = AsyncOpenAI(
        api_key="sk-test",
        base_url="https://openai.test/v1",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    return OpenAIChatProvider(client, "gpt-4.1-mini")


async def collect(provider: OpenAIChatProvider) -> list[Any]:
    return [event async for event in provider.stream(MESSAGES, DRAFT_SCHEMA, 700)]


async def test_streams_deltas_and_reports_usage_with_a_strict_schema_request() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        stream = (
            chunk('{"title"')
            + chunk(': "x"}')
            + chunk(finish="stop")
            + chunk(usage={"prompt_tokens": 120, "completion_tokens": 8, "total_tokens": 128})
            + "data: [DONE]\n\n"
        )
        return httpx.Response(200, text=stream, headers={"content-type": "text/event-stream"})

    events = await collect(provider_for(handler))

    assert seen["url"] == "https://openai.test/v1/chat/completions"
    assert seen["auth"] == "Bearer sk-test"
    body = seen["body"]
    assert body["model"] == "gpt-4.1-mini"
    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}
    assert body["max_completion_tokens"] == 700
    assert body["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "issue_draft", "strict": True, "schema": DRAFT_SCHEMA.schema},
    }
    assert body["messages"] == [
        {"role": "system", "content": "rules"},
        {"role": "user", "content": "text"},
    ]
    assert events[:2] == [TextDelta('{"title"'), TextDelta(': "x"}')]
    assert events[-1] == Completion(
        text='{"title": "x"}', model="gpt-4.1-mini-2025-04-14", usage=Usage(120, 8)
    )


@pytest.mark.parametrize(
    ("status", "retryable"),
    [(429, True), (500, True), (503, True), (400, False), (401, False)],
)
async def test_http_errors_map_to_provider_errors(status: int, retryable: bool) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json={"error": {"message": "nope", "type": "x"}})

    with pytest.raises(ProviderError) as caught:
        await collect(provider_for(handler))
    assert caught.value.retryable is retryable


async def test_a_network_failure_is_retryable() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused", request=request)

    with pytest.raises(ProviderError) as caught:
        await collect(provider_for(handler))
    assert caught.value.retryable is True


async def test_output_cut_off_at_the_token_limit_is_an_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        stream = chunk('{"title": "unfini') + chunk(finish="length") + "data: [DONE]\n\n"
        return httpx.Response(200, text=stream, headers={"content-type": "text/event-stream"})

    with pytest.raises(ProviderError, match="cut off") as caught:
        await collect(provider_for(handler))
    assert caught.value.retryable is False


def raw_chunk(delta: dict[str, Any], finish: str | None = None) -> str:
    body = {
        "id": "chatcmpl-2",
        "object": "chat.completion.chunk",
        "created": 1,
        "model": "gpt-4.1-mini-2025-04-14",
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
    }
    return f"data: {json.dumps(body)}\n\n"


QUERY_TOOL = Tool("query_issues", "List issues", {"type": "object", "properties": {}})
USAGE = chunk(usage={"prompt_tokens": 50, "completion_tokens": 9, "total_tokens": 59})


async def test_chat_streams_text_without_tools_when_none_are_offered() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        stream = chunk("Fixed ") + chunk("[1].") + chunk(finish="stop") + USAGE + "data: [DONE]\n\n"
        return httpx.Response(200, text=stream, headers={"content-type": "text/event-stream"})

    provider = provider_for(handler)
    events = [e async for e in provider.stream_chat(MESSAGES, [], 300)]

    assert "tools" not in seen["body"]
    assert "parallel_tool_calls" not in seen["body"]
    assert "response_format" not in seen["body"]
    assert events == [
        TextDelta("Fixed "),
        TextDelta("[1]."),
        Completion("Fixed [1].", "gpt-4.1-mini-2025-04-14", Usage(50, 9)),
    ]


async def test_chat_assembles_a_streamed_tool_call() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        call = {"index": 0, "id": "call_1", "type": "function"}
        stream = (
            raw_chunk(
                {"tool_calls": [{**call, "function": {"name": "query_issues", "arguments": ""}}]}
            )
            + raw_chunk({"tool_calls": [{"index": 0, "function": {"arguments": '{"project_key"'}}]})
            + raw_chunk({"tool_calls": [{"index": 0, "function": {"arguments": ': "PAY"}'}}]})
            + raw_chunk({}, finish="tool_calls")
            + USAGE
            + "data: [DONE]\n\n"
        )
        return httpx.Response(200, text=stream, headers={"content-type": "text/event-stream"})

    provider = provider_for(handler)
    events = [e async for e in provider.stream_chat(MESSAGES, [QUERY_TOOL], 300)]

    assert seen["body"]["tools"] == [
        {
            "type": "function",
            "function": {
                "name": "query_issues",
                "description": "List issues",
                "parameters": {"type": "object", "properties": {}},
                "strict": True,
            },
        }
    ]
    assert seen["body"]["parallel_tool_calls"] is False
    assert events == [
        ToolCall("call_1", "query_issues", '{"project_key": "PAY"}'),
        Completion("", "gpt-4.1-mini-2025-04-14", Usage(50, 9)),
    ]


async def test_chat_sends_tool_turns_in_openai_format() -> None:
    seen: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        stream = chunk("ok") + chunk(finish="stop") + USAGE + "data: [DONE]\n\n"
        return httpx.Response(200, text=stream, headers={"content-type": "text/event-stream"})

    call = ToolCall("call_1", "query_issues", "{}")
    messages: list[ChatMessage] = [
        *MESSAGES,
        {"role": "tool_call", "call": call},
        {"role": "tool", "call_id": "call_1", "content": "2 issues"},
    ]
    _ = [e async for e in provider_for(handler).stream_chat(messages, [], 300)]

    assert seen["body"]["messages"][2:] == [
        {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": "call_1",
                    "type": "function",
                    "function": {"name": "query_issues", "arguments": "{}"},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "call_1", "content": "2 issues"},
    ]
