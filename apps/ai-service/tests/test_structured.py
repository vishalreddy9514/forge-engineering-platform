import json

import pytest

from app.features.drafts import DRAFT_SCHEMA, IssueDraft, keep_known_labels
from app.features.structured import InvalidOutputError, generate
from app.llm.base import Message, Usage
from app.llm.fake import FakeChatProvider

MESSAGES: list[Message] = [{"role": "user", "content": "draft please"}]
VALID = {
    "title": "Refunds fail for partial captures",
    "description": "It fails.",
    "acceptance_criteria": ["Given a partial capture, when refunded, then it succeeds"],
    "type": "BUG",
    "priority": "HIGH",
    "priority_rationale": "Money is stuck.",
    "labels": ["Payments", "made-up"],
    "technical_area": "payments API",
}


async def test_valid_output_is_used_as_is() -> None:
    provider = FakeChatProvider(replies=[json.dumps(VALID)])
    result = await generate(provider, MESSAGES, DRAFT_SCHEMA, IssueDraft, 500)
    assert result.value.title == VALID["title"]
    assert result.repaired is False
    assert len(provider.calls) == 1


async def test_invalid_output_is_repaired_once_with_the_exact_problem() -> None:
    broken = {**VALID, "priority": "URGENT"}
    provider = FakeChatProvider(replies=[json.dumps(broken), json.dumps(VALID)])
    result = await generate(provider, MESSAGES, DRAFT_SCHEMA, IssueDraft, 500)
    assert result.repaired is True
    repair_request = provider.calls[1]
    assert repair_request[-2] == {"role": "assistant", "content": json.dumps(broken)}
    assert "priority" in repair_request[-1]["content"]
    # Usage covers both calls.
    assert result.usage.input_tokens > 0
    assert result.usage == _usage(provider, 0) + _usage(provider, 1)


async def test_two_invalid_outputs_are_an_error_and_report_what_they_cost() -> None:
    provider = FakeChatProvider(replies=["not json", "{}"])
    with pytest.raises(InvalidOutputError) as caught:
        await generate(provider, MESSAGES, DRAFT_SCHEMA, IssueDraft, 500)
    assert "title" in str(caught.value)
    assert caught.value.usage.output_tokens > 0


def test_labels_are_limited_to_the_project_and_use_its_spelling() -> None:
    draft = IssueDraft.model_validate(
        {**VALID, "labels": ["payments", "PAYMENTS", "made-up", "Bug"]}
    )
    kept, dropped = keep_known_labels(draft, ["Payments", "bug", "frontend"])
    assert kept.labels == ["Payments", "bug"]
    assert dropped == ["made-up"]


def _usage(provider: FakeChatProvider, call: int) -> Usage:
    from app.llm.tokens import estimate_tokens

    prompt = "".join(m["content"] for m in provider.calls[call])
    reply = [json.dumps({**VALID, "priority": "URGENT"}), json.dumps(VALID)][call]
    return Usage(estimate_tokens(prompt), estimate_tokens(reply))
