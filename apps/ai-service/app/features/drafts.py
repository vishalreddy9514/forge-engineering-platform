"""FR-7.1: turn free text into a structured issue draft the user reviews before saving."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.core.wire import Wire
from app.llm.base import Message
from app.llm.schema import output_schema
from app.prompts import ISSUE_DRAFT

Text = Annotated[str, StringConstraints(strip_whitespace=True)]


class DraftRequest(Wire):
    text: Annotated[str, StringConstraints(strip_whitespace=True, min_length=10, max_length=8000)]
    project_key: Annotated[str, StringConstraints(pattern=r"^[A-Z][A-Z0-9]{1,9}$")]
    project_name: Annotated[str, StringConstraints(min_length=1, max_length=100)]
    labels: Annotated[list[Annotated[str, StringConstraints(max_length=50)]], Field(max_length=100)]


class IssueDraft(BaseModel):
    """What the model must return. Mirrors IssueDraft in @forge/types (contract-tested)."""

    model_config = ConfigDict(extra="forbid")

    title: Annotated[Text, StringConstraints(min_length=3, max_length=200)]
    description: Annotated[Text, StringConstraints(max_length=10_000)]
    acceptance_criteria: Annotated[
        list[Annotated[Text, StringConstraints(min_length=5, max_length=500)]],
        Field(min_length=1, max_length=8),
    ]
    type: Literal["BUG", "FEATURE", "TASK", "CHORE"]
    priority: Literal["CRITICAL", "HIGH", "MEDIUM", "LOW"]
    priority_rationale: Annotated[Text, StringConstraints(max_length=300)]
    labels: Annotated[list[Text], Field(max_length=6)]
    technical_area: Annotated[Text, StringConstraints(max_length=80)]


DRAFT_SCHEMA = output_schema(IssueDraft, "issue_draft")
DRAFT_MAX_OUTPUT_TOKENS = 1_500


def prompt_for(request: DraftRequest) -> tuple[str, list[Message]]:
    return ISSUE_DRAFT.version, ISSUE_DRAFT.render(
        project_key=request.project_key,
        project_name=request.project_name,
        labels=request.labels,
        text=request.text,
    )


def keep_known_labels(draft: IssueDraft, allowed: list[str]) -> tuple[IssueDraft, list[str]]:
    """Labels are chosen from the project's list only (FR-7.1). A label the model made up is
    dropped, and a known one is returned in the project's own spelling."""
    canonical = {label.casefold(): label for label in allowed}
    kept: list[str] = []
    dropped: list[str] = []
    for label in draft.labels:
        match = canonical.get(label.casefold())
        if match is None:
            dropped.append(label)
        elif match not in kept:
            kept.append(match)
    return draft.model_copy(update={"labels": kept}), dropped
