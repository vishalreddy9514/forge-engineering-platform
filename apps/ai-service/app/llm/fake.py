"""A deterministic stand-in for the model (architecture §7.1).

It reads the same prompts the real model gets and produces plausible, schema-valid output from
simple rules, so the whole product works locally without an API key and every test is
repeatable. It is not a model: quality is measured with the real provider, never with this.

`replies` scripts exact outputs instead (tests for invalid output and repair).
"""

import json
import re
from collections.abc import AsyncIterator, Iterator
from typing import Any

from app.llm.base import (
    Completion,
    Message,
    OutputSchema,
    ProviderError,
    StreamEvent,
    TextDelta,
    Usage,
)
from app.llm.tokens import estimate_tokens

_BLOCK = re.compile(r"<untrusted_input>\n?(.*?)\n?</untrusted_input>", re.DOTALL)
_LABELS = re.compile(r"<labels>(.*?)</labels>", re.DOTALL)
_CHUNK = 24


class FakeChatProvider:
    model = "fake"

    def __init__(self, replies: list[str] | None = None) -> None:
        self._replies: Iterator[str] | None = iter(replies) if replies is not None else None
        self.calls: list[list[Message]] = []

    async def stream(
        self, messages: list[Message], schema: OutputSchema, max_output_tokens: int
    ) -> AsyncIterator[StreamEvent]:
        self.calls.append(messages)
        if self._replies is not None:
            text = next(self._replies, None)
            if text is None:
                raise ProviderError("No scripted reply left", retryable=False)
        else:
            text = json.dumps(_answer(schema.name, messages[-1]["content"]), ensure_ascii=False)
        for start in range(0, len(text), _CHUNK):
            yield TextDelta(text[start : start + _CHUNK])
        prompt = "".join(m["content"] for m in messages)
        yield Completion(text, self.model, Usage(estimate_tokens(prompt), estimate_tokens(text)))


def _answer(schema: str, prompt: str) -> dict[str, Any]:
    block = _BLOCK.search(prompt)
    text = block.group(1).strip() if block else prompt
    if schema == "issue_draft":
        labels_match = _LABELS.search(prompt)
        labels: list[str] = json.loads(labels_match.group(1)) if labels_match else []
        return _draft(text, labels)
    if schema == "thread_summary":
        return _summary(text)
    raise ProviderError(f"The fake provider has no rule for {schema}", retryable=False)


def _has(text: str, *words: str) -> bool:
    return any(re.search(rf"\b{re.escape(w)}", text, re.IGNORECASE) for w in words)


def _draft(text: str, labels: list[str]) -> dict[str, Any]:
    first = re.split(r"(?<=[.!?])\s|\n", text.strip(), maxsplit=1)[0].strip(" .")
    title = (first[:97] + "…") if len(first) > 100 else first
    title = title[:1].upper() + title[1:] if title else "Untitled request"

    if _has(
        text,
        "error",
        "crash",
        "fail",
        "broken",
        "bug",
        "500",
        "exception",
        "wrong",
        "cannot",
        "can't",
        "doesn't",
        "twice",
    ):
        kind = "BUG"
    elif _has(text, "add", "support", "allow", "would like", "should be able", "feature"):
        kind = "FEATURE"
    else:
        kind = "TASK"

    if _has(
        text,
        "outage",
        "down for",
        "data loss",
        "security",
        "breach",
        "charged twice",
        "double-charg",
    ):
        priority, why = "CRITICAL", "Customers or data are affected right now."
    elif _has(text, "crash", "fail", "500", "cannot", "can't", "blocked"):
        priority, why = "HIGH", "Users are blocked and there is no stated workaround."
    elif _has(text, "typo", "cosmetic", "alignment", "colour", "color", "spacing"):
        priority, why = "LOW", "Cosmetic, with no functional impact."
    else:
        priority, why = "MEDIUM", "Default priority: no urgency is stated in the request."

    bug_label = [label for label in labels if kind == "BUG" and label.casefold() == "bug"]
    mentioned = [label for label in labels if _has(text, label) and label not in bug_label]
    chosen = [*bug_label, *mentioned][:4]

    quoted = "\n".join(f"> {line}" if line else ">" for line in text.splitlines())
    if kind == "BUG":
        description = (
            f"## What happens\n\n{quoted}\n\n## Expected\n\nNot stated in the report; "
            "confirm with the reporter.\n\n## Impact\n\nUnknown until reproduced."
        )
        criteria = [
            f"Given the situation described, when it happens again, then {title[:1].lower() + title[1:]} no longer occurs",  # noqa: E501
            "Given the fix is deployed, when the regression test runs, then it passes",
        ]
    else:
        description = f"## Request\n\n{quoted}\n\n## Proposed behaviour\n\nTo be refined."
        outcome = first[:1].lower() + first[1:] or "it works"
        criteria = [f"Given the change is released, when a user tries it, then {outcome}"]

    return {
        "title": title,
        "description": description,
        "acceptance_criteria": criteria,
        "type": kind,
        "priority": priority,
        "priority_rationale": why,
        "labels": chosen,
        "technical_area": mentioned[0] if mentioned else "general",
    }


def _summary(thread: str) -> dict[str, Any]:
    header = thread.splitlines()[0] if thread else "The issue"
    comments = re.findall(r"^\[\d+\] (.+?), \S+:\n(.*?)(?=^\[\d+\] |\Z)", thread, re.M | re.S)
    status = re.search(r"^Status: (\S+)", thread, re.M)

    def sentences(pattern: str) -> list[str]:
        found: list[str] = []
        for author, body in comments:
            for sentence in re.split(r"(?<=[.!?])\s+", body.strip()):
                if re.search(pattern, sentence, re.IGNORECASE) and len(found) < 5:
                    found.append(f"{author}: {sentence.strip()}"[:400])
        return found

    tldr = f"{header.removeprefix('Issue ')}."
    tldr += f" Status: {status.group(1)}." if status else ""
    tldr += f" {len(comments)} comment(s) in the discussion." if comments else " No discussion yet."
    return {
        "tldr": tldr[:1000],
        "key_decisions": sentences(r"\b(decided|agreed|we will|let's go with|going with)\b"),
        "open_questions": sentences(r"\?$"),
        "next_steps": sentences(r"\b(next|todo|i'll|i will|will add|follow up)\b"),
    }
