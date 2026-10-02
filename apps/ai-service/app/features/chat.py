"""FR-7.4: assistant chat, answered from retrieved project data with cited sources.

A turn is one or two requests from the API. The first retrieves and lets the model either answer
or call `query_issues`. The service cannot execute that tool itself: it holds no credentials for
the API and has no network path to it. It returns the call instead, and the API runs the query
with the user's own permissions and sends the result back in a second request, which must
answer. The service stays stateless, and the only data the model ever sees is data the API or
the permission-filtered retrieval handed over for this user.
"""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal, Self

from pydantic import Field, StringConstraints, model_validator

from app.core.wire import Wire
from app.llm.base import ChatProvider, Completion, Message, TextDelta, ToolCall
from app.prompts import CHAT_ANSWER
from app.rag import answer
from app.rag.answer import Source
from app.rag.embedder import Embeddings
from app.rag.retriever import Retriever

Key = Annotated[str, StringConstraints(pattern=r"^[A-Z][A-Z0-9]{1,9}$")]


class ChatTurn(Wire):
    role: Literal["user", "assistant"]
    content: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=8000)]


class ProjectIn(Wire):
    id: uuid.UUID
    key: Key
    name: Annotated[str, StringConstraints(max_length=100)]


class ToolIssue(Wire):
    id: uuid.UUID
    project_id: uuid.UUID
    key: Annotated[str, StringConstraints(max_length=20)]
    title: Annotated[str, StringConstraints(max_length=300)]
    type: str
    status: str
    priority: str
    assignee: Annotated[str, StringConstraints(max_length=100)] | None
    updated_at: datetime
    url: Annotated[str, StringConstraints(max_length=500)]


class ToolCallIn(Wire):
    id: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    name: Literal["query_issues"]
    arguments: Annotated[str, StringConstraints(max_length=2000)]


class ToolResultIn(Wire):
    issues: Annotated[list[ToolIssue], Field(max_length=50)]
    total: Annotated[int, Field(ge=0)]


class ChatRequest(Wire):
    messages: Annotated[list[ChatTurn], Field(min_length=1, max_length=40)]
    # Every project the user may read. Required: an empty list retrieves nothing (§7.4).
    projects: Annotated[list[ProjectIn], Field(max_length=500)]
    tool_call: ToolCallIn | None = None
    tool_result: ToolResultIn | None = None

    @model_validator(mode="after")
    def _shape(self) -> Self:
        if self.messages[-1].role != "user":
            raise ValueError("The last message must be the user's question")
        if (self.tool_call is None) != (self.tool_result is None):
            raise ValueError("toolCall and toolResult are sent together")
        return self


@dataclass(frozen=True)
class ChatToolRequest:
    call: ToolCall
    arguments: dict[str, Any]
    completion: Completion
    embedding: Embeddings


@dataclass(frozen=True)
class ChatAnswer:
    answer: str
    citations: list[Source]
    completion: Completion
    embedding: Embeddings


CHAT_PROMPT_VERSION = CHAT_ANSWER.version


def tool_sources(issues: list[ToolIssue], start: int) -> list[Source]:
    return [
        Source(
            n=start + i,
            source_type="ISSUE",
            source_id=issue.id,
            document_id=None,
            project_id=issue.project_id,
            title=f"{issue.key}: {issue.title}",
            url=issue.url,
            heading_path=None,
            content=(
                f"{issue.key} · {issue.type} · {issue.priority} · {issue.status} · "
                f"assignee {issue.assignee or 'none'} · updated {issue.updated_at.date()}\n"
                f"{issue.title}"
            ),
        )
        for i, issue in enumerate(issues)
    ]


async def run(
    request: ChatRequest, retriever: Retriever, provider: ChatProvider
) -> AsyncIterator[TextDelta | ChatToolRequest | ChatAnswer]:
    question = request.messages[-1].content
    history: list[Message] = [
        {"role": turn.role, "content": turn.content} for turn in request.messages[:-1]
    ]
    projects = [answer.ProjectRef(p.id, p.key, p.name) for p in request.projects]
    ranked, embedding = await retriever.retrieve(question, [p.id for p in projects])
    sources = answer.sources_from(ranked)

    # One tool round at most: after a result comes back the model has to answer.
    offer_tool = bool(projects) and request.tool_call is None
    tools = [answer.query_issues_tool([p.key for p in projects])] if offer_tool else []
    messages = answer.chat_messages(history, question, sources, projects, tools)
    if request.tool_call is not None and request.tool_result is not None:
        results = tool_sources(request.tool_result.issues, start=len(sources) + 1)
        call = ToolCall(request.tool_call.id, request.tool_call.name, request.tool_call.arguments)
        messages = answer.with_tool_result(messages, call, results, request.tool_result.total)
        sources = [*sources, *results]

    tool_call: ToolCall | None = None
    async for event in provider.stream_chat(messages, tools, answer.CHAT_MAX_OUTPUT_TOKENS):
        if isinstance(event, TextDelta):
            yield event
        elif isinstance(event, ToolCall):
            tool_call = event
        elif tool_call is not None and offer_tool:
            yield ChatToolRequest(
                tool_call, answer.parse_tool_arguments(tool_call), event, embedding
            )
            return
        else:
            text, cited = answer.map_citations(event.text, sources)
            # A reply with no text (a tool call when none was offered) is not an answer.
            yield ChatAnswer(text or answer.NO_ANSWER, cited, event, embedding)
