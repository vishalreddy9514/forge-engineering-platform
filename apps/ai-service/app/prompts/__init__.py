"""Versioned prompt templates (architecture §7.1).

Each prompt has an ID and a version; the version is returned with every output and stored with
it (ai_summaries.prompt_version, ai_usage.prompt_version), so a change in output quality can be
traced to the prompt that produced it. Change a template → bump its version.

Text from users, issues and comments is untrusted (OWASP LLM01, indirect prompt injection). It is
only ever placed inside <untrusted_input> blocks through the `fence` filter, which neutralises
anything inside it that looks like the block's own tags, so the text cannot close the block
and continue as instructions.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jinja2 import Environment, FileSystemLoader, StrictUndefined

from app.llm.base import Message

_TAG = re.compile(r"<(/?)(untrusted_input)", re.IGNORECASE)


def fence(text: str) -> str:
    """Makes text safe to place inside an <untrusted_input> block."""
    # str() also makes a missing (StrictUndefined) variable raise instead of rendering blank.
    return _TAG.sub(r"<\1\2_", str(text))


_env = Environment(
    loader=FileSystemLoader(Path(__file__).parent / "templates"),
    undefined=StrictUndefined,  # a missing variable is a bug, not an empty string
    autoescape=False,  # noqa: S701 - prompts are plain text, not HTML; untrusted text is fenced
    keep_trailing_newline=False,
    trim_blocks=True,
    lstrip_blocks=True,
)
_env.filters["fence"] = fence


@dataclass(frozen=True)
class Prompt:
    id: str
    version: str

    def render(self, **variables: Any) -> list[Message]:
        return [
            {"role": "system", "content": self._render("system", variables)},
            {"role": "user", "content": self._render("user", variables)},
        ]

    def _render(self, part: str, variables: dict[str, Any]) -> str:
        return _env.get_template(f"{self.id}.{part}.j2").render(**variables).strip()


ISSUE_DRAFT = Prompt(id="issue_draft", version="issue_draft@1")
THREAD_SUMMARY = Prompt(id="thread_summary", version="thread_summary@1")
