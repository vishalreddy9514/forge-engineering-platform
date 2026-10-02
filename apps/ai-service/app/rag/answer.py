"""Context assembly and citation mapping for assistant chat (FR-7.4, FR-8.5).

Retrieved chunks become numbered sources in the prompt; the model cites them as [n]. After
generation every [n] is checked against the sources that were actually shown: a number the model
invented is removed from the answer rather than linked to something it never saw.
"""

import json
import re
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from app.llm.base import ChatMessage, Message, Tool, ToolCall, ToolCallTurn, ToolResultTurn
from app.llm.tokens import estimate_tokens, truncate_to_tokens
from app.prompts import CHAT_ANSWER, fence
from app.rag.chunking import SourceType
from app.rag.retriever import Ranked

CONTEXT_CHUNKS = 8
# Retrieved text in one prompt. Eight chunks of about 500 tokens fit; one huge chunk cannot
# crowd out the rest because each is also capped.
CONTEXT_TOKEN_BUDGET = 5_000
PER_SOURCE_TOKENS = 900
# Earlier turns kept for follow-up questions ("and who fixed it?").
HISTORY_TURNS = 6
HISTORY_TURN_TOKENS = 600
CHAT_MAX_OUTPUT_TOKENS = 800
NO_ANSWER = "I don't know: I couldn't produce an answer from the project data."


@dataclass(frozen=True)
class Source:
    n: int
    source_type: SourceType
    source_id: uuid.UUID | None
    document_id: uuid.UUID | None
    project_id: uuid.UUID
    title: str
    url: str
    heading_path: str | None
    content: str


def sources_from(ranked: list[Ranked], start: int = 1) -> list[Source]:
    """The top chunks, numbered from `start`, within the context budget."""
    sources: list[Source] = []
    used = 0
    for item in ranked[:CONTEXT_CHUNKS]:
        content = truncate_to_tokens(item.hit.content, PER_SOURCE_TOKENS)
        cost = estimate_tokens(content)
        if sources and used + cost > CONTEXT_TOKEN_BUDGET:
            break
        used += cost
        hit = item.hit
        sources.append(
            Source(
                n=start + len(sources),
                source_type=hit.source_type,
                source_id=hit.source_id,
                document_id=hit.document_id,
                project_id=hit.project_id,
                title=hit.title,
                url=hit.url,
                heading_path=hit.heading_path,
                content=content,
            )
        )
    return sources


def render_source(source: Source) -> str:
    """One numbered source for the prompt. Every field is untrusted text and fenced."""
    title = fence(source.title).replace('"', "'")
    path = fence(source.heading_path).replace('"', "'") if source.heading_path else None
    section = f' section="{path}"' if path else ""
    return (
        f'<source n="{source.n}" type="{source.source_type}" title="{title}"{section}>\n'
        f"{fence(source.content)}\n</source>"
    )


@dataclass(frozen=True)
class ProjectRef:
    id: uuid.UUID
    key: str
    name: str


def chat_messages(
    history: list[Message],
    question: str,
    sources: list[Source],
    projects: list[ProjectRef],
    tools: list[Tool],
) -> list[ChatMessage]:
    """System rules, recent history, then the question with its numbered sources."""
    system, user = CHAT_ANSWER.render(
        projects=projects,
        tools=bool(tools),
        source_blocks=[render_source(s) for s in sources],
        question=question,
    )
    recent: list[ChatMessage] = [
        {"role": turn["role"], "content": truncate_to_tokens(turn["content"], HISTORY_TURN_TOKENS)}
        for turn in history[-HISTORY_TURNS:]
    ]
    return [system, *recent, user]


def with_tool_result(
    messages: list[ChatMessage], call: ToolCall, results: list[Source], total: int
) -> list[ChatMessage]:
    """Appends the tool call and its results (numbered sources, like retrieved ones)."""
    blocks = "\n".join(render_source(s) for s in results) or "(no matching issues)"
    content = (
        f"{total} issue(s) matched; the first {len(results)} are listed.\n"
        f"<untrusted_input>\n{blocks}\n</untrusted_input>"
    )
    call_turn: ToolCallTurn = {"role": "tool_call", "call": call}
    result_turn: ToolResultTurn = {"role": "tool", "call_id": call.id, "content": content}
    return [*messages, call_turn, result_turn]


# ------------------------------------------------------------------ citations

_CITATION = re.compile(r"\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]")


def map_citations(answer: str, sources: list[Source]) -> tuple[str, list[Source]]:
    """Returns the answer with invalid citation numbers removed, and the sources it cites in
    order of first citation."""
    by_number = {s.n: s for s in sources}
    cited: list[Source] = []

    def replace(match: re.Match[str]) -> str:
        valid = []
        for part in match.group(1).split(","):
            number = int(part)
            if number in by_number:
                valid.append(number)
                if by_number[number] not in cited:
                    cited.append(by_number[number])
        return "".join(f"[{n}]" for n in valid)

    cleaned = _CITATION.sub(replace, answer)
    # Removing a citation can leave a space before punctuation: "fixed [9]." → "fixed ."
    cleaned = re.sub(r"[ \t]+([.,;:!?])", r"\1", cleaned)
    return cleaned.strip(), cited


# ------------------------------------------------------------------ query_issues tool

StatusCategory = Literal["open", "in_progress", "done"]


def query_issues_tool(project_keys: list[str]) -> Tool:
    """The one read-only tool (architecture §7.2). The API executes it with the caller's own
    permissions; the arguments are validated there again, never trusted from the model."""
    return Tool(
        name="query_issues",
        description=(
            "List issues in one project by structured filters. Use it for questions that count "
            "or list issues (which, how many, list), not for why or how questions."
        ),
        parameters={
            "type": "object",
            "additionalProperties": False,
            "required": [
                "project_key",
                "type",
                "status",
                "priority",
                "sprint",
                "updated_within_days",
            ],
            "properties": {
                "project_key": {"type": "string", "enum": project_keys},
                "type": _nullable_enum(["BUG", "FEATURE", "TASK", "CHORE"]),
                "status": _nullable_enum(["open", "in_progress", "done"]),
                "priority": _nullable_enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
                "sprint": _nullable_enum(["active", "last_completed"]),
                "updated_within_days": {"type": ["integer", "null"], "minimum": 1, "maximum": 365},
            },
        },
    )


def _nullable_enum(values: list[str]) -> dict[str, Any]:
    return {"type": ["string", "null"], "enum": [*values, None]}


def parse_tool_arguments(call: ToolCall) -> dict[str, Any]:
    """The model's arguments as JSON (validated by the API, which executes the query)."""
    try:
        value = json.loads(call.arguments or "{}")
    except ValueError:
        return {}
    return value if isinstance(value, dict) else {}
