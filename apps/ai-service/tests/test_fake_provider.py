import json

from app.features.drafts import DRAFT_SCHEMA, DraftRequest, IssueDraft, prompt_for
from app.features.summaries import (
    SUMMARY_SCHEMA,
    SummaryRequest,
    ThreadSummary,
)
from app.features.summaries import prompt_for as summary_prompt
from app.llm.base import Completion, TextDelta, complete
from app.llm.fake import FakeChatProvider


def draft_request(text: str, labels: list[str] | None = None) -> DraftRequest:
    return DraftRequest(
        text=text,
        project_key="PAY",
        project_name="Payments",
        labels=labels if labels is not None else ["bug", "payments", "frontend"],
    )


async def draft(text: str, labels: list[str] | None = None) -> IssueDraft:
    _, messages = prompt_for(draft_request(text, labels))
    result = await complete(FakeChatProvider(), messages, DRAFT_SCHEMA, 1000)
    return IssueDraft.model_validate(json.loads(result.text))


async def test_bug_reports_become_valid_bug_drafts() -> None:
    result = await draft(
        "Customers are charged twice when the Stripe webhook retries. Seen on payments page."
    )
    assert result.type == "BUG"
    assert result.priority == "CRITICAL"
    assert result.title == "Customers are charged twice when the Stripe webhook retries"
    assert result.labels == ["bug", "payments"]
    assert result.acceptance_criteria[0].startswith("Given")


async def test_feature_requests_and_cosmetic_issues() -> None:
    feature = await draft("Add support for Apple Pay on the web checkout please")
    assert (feature.type, feature.priority) == ("FEATURE", "MEDIUM")
    cosmetic = await draft("There is a typo on the receipt email footer text")
    assert cosmetic.priority == "LOW"


async def test_it_is_deterministic_and_streams_in_pieces() -> None:
    _, messages = prompt_for(draft_request("The refund page fails with a 500 error"))
    runs = []
    for _ in range(2):
        events = [e async for e in FakeChatProvider().stream(messages, DRAFT_SCHEMA, 1000)]
        runs.append(events)
    assert runs[0] == runs[1]
    deltas = [e for e in runs[0] if isinstance(e, TextDelta)]
    final = runs[0][-1]
    assert len(deltas) > 1
    assert isinstance(final, Completion)
    assert "".join(d.text for d in deltas) == final.text
    assert final.usage.input_tokens > 0


async def test_summaries_pick_out_decisions_questions_and_next_steps() -> None:
    request = SummaryRequest.model_validate(
        {
            "issue": {
                "key": "PAY-1",
                "title": "Double charges",
                "description": "Webhook retries charge twice.",
                "status": "IN_PROGRESS",
                "priority": "CRITICAL",
                "type": "BUG",
            },
            "comments": [
                {
                    "author": "Sam",
                    "created_at": "2026-09-01T10:00:00Z",
                    "body": "We decided to store event IDs. Should we backfill old events?",
                },
                {
                    "author": "Mei",
                    "created_at": "2026-09-02T10:00:00Z",
                    "body": "I'll add the regression test next.",
                },
            ],
        }
    )
    _, messages, omitted = summary_prompt(request, 12_000)
    result = await complete(FakeChatProvider(), messages, SUMMARY_SCHEMA, 1000)
    summary = ThreadSummary.model_validate(json.loads(result.text))
    assert omitted == 0
    assert summary.tldr.startswith("PAY-1: Double charges.")
    assert summary.key_decisions == ["Sam: We decided to store event IDs."]
    assert summary.open_questions == ["Sam: Should we backfill old events?"]
    assert summary.next_steps == ["Mei: I'll add the regression test next."]
