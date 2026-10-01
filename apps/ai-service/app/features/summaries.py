"""FR-7.2: summarise an issue and its comment thread."""

from datetime import datetime
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.core.wire import Wire
from app.llm.base import Message
from app.llm.schema import output_schema
from app.llm.tokens import estimate_tokens, truncate_to_tokens
from app.prompts import THREAD_SUMMARY

Text = Annotated[str, StringConstraints(strip_whitespace=True)]
Item = Annotated[Text, StringConstraints(min_length=1, max_length=400)]


class SummaryIssue(Wire):
    key: Annotated[str, StringConstraints(max_length=20)]
    title: Annotated[str, StringConstraints(max_length=200)]
    description: Annotated[str, StringConstraints(max_length=100_000)] | None
    status: str
    priority: str
    type: str


class SummaryComment(Wire):
    author: Annotated[str, StringConstraints(max_length=100)]
    created_at: datetime
    body: Annotated[str, StringConstraints(max_length=20_000)]


class SummaryRequest(Wire):
    issue: SummaryIssue
    comments: Annotated[list[SummaryComment], Field(max_length=2_000)]


class ThreadSummary(BaseModel):
    """Mirrors ThreadSummary in @forge/types (contract-tested)."""

    model_config = ConfigDict(extra="forbid")

    tldr: Annotated[Text, StringConstraints(min_length=1, max_length=1_000)]
    key_decisions: Annotated[list[Item], Field(max_length=10)]
    open_questions: Annotated[list[Item], Field(max_length=10)]
    next_steps: Annotated[list[Item], Field(max_length=10)]


SUMMARY_SCHEMA = output_schema(ThreadSummary, "thread_summary")
SUMMARY_MAX_OUTPUT_TOKENS = 1_200
# Share of the input budget the description may use before it is shortened.
_DESCRIPTION_SHARE = 0.3


def prompt_for(request: SummaryRequest, max_input_tokens: int) -> tuple[str, list[Message], int]:
    """Messages within the input budget, and how many (oldest) comments were left out.

    The description is kept (shortened if very long) and the newest comments are kept, since
    they carry the current state; the oldest are dropped first and the prompt says so.
    """
    budget = max_input_tokens - 800  # instructions and formatting
    description = request.issue.description
    if description is not None:
        description = truncate_to_tokens(description, int(max_input_tokens * _DESCRIPTION_SHARE))
        budget -= estimate_tokens(description)

    kept: list[SummaryComment] = []
    for comment in reversed(request.comments):
        cost = estimate_tokens(comment.body) + 20
        if cost > budget:
            break
        kept.append(comment)
        budget -= cost
    kept.reverse()
    omitted = len(request.comments) - len(kept)

    messages = THREAD_SUMMARY.render(
        issue=request.issue.model_copy(update={"description": description}),
        comments=[
            {"author": c.author, "created_at": c.created_at.date().isoformat(), "body": c.body}
            for c in kept
        ],
        omitted=omitted,
    )
    return THREAD_SUMMARY.version, messages, omitted
