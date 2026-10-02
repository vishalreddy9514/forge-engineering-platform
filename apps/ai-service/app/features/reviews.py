"""FR-9.2: review a pull request file by file, then summarise.

One structured call per file keeps each prompt small and focused, lets files be reviewed in
parallel, and means one unreadable file does not cost the whole review. A final call turns the
per-file results into a summary and the tests the change is missing. Every line a finding points
at is checked against the diff; anything else becomes a file-level remark.
"""

import asyncio
import json
from dataclasses import dataclass, field
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.core.wire import Wire
from app.features.structured import InvalidOutputError, generate
from app.llm.base import ChatProvider, ProviderError, Usage
from app.llm.schema import output_schema
from app.llm.tokens import CHARS_PER_TOKEN
from app.prompts import PR_REVIEW_FILE, PR_REVIEW_SUMMARY
from app.review.diff import numbered, parse_patch, reviewable_lines

Text = Annotated[str, StringConstraints(strip_whitespace=True)]

MAX_FILES = 60
# One file's diff in one prompt; longer diffs are cut and the prompt says so.
FILE_DIFF_TOKENS = 6_000
FILE_MAX_OUTPUT_TOKENS = 2_000
SUMMARY_MAX_OUTPUT_TOKENS = 1_200
# Files reviewed at the same time: enough to finish a large PR in seconds, few enough not to
# trip the provider's per-minute limits.
CONCURRENCY = 4

Severity = Literal["critical", "major", "minor", "nit"]
Category = Literal["bug", "security", "performance", "maintainability", "style", "testing"]
SEVERITY_ORDER: dict[str, int] = {"critical": 0, "major": 1, "minor": 2, "nit": 3}


# ------------------------------------------------------------------ request


class PullRequestIn(Wire):
    number: Annotated[int, Field(ge=1)]
    title: Annotated[str, StringConstraints(max_length=300)]
    body: Annotated[str, StringConstraints(max_length=20_000)] | None = None
    repository: Annotated[str, StringConstraints(max_length=200)]


class FileIn(Wire):
    path: Annotated[str, StringConstraints(min_length=1, max_length=500)]
    status: Literal["added", "modified", "renamed", "copied", "changed"]
    additions: Annotated[int, Field(ge=0)]
    deletions: Annotated[int, Field(ge=0)]
    patch: Annotated[str, StringConstraints(max_length=400_000)]


class OmittedFile(Wire):
    path: Annotated[str, StringConstraints(max_length=500)]
    reason: Annotated[str, StringConstraints(max_length=100)]


class ReviewRequest(Wire):
    pull_request: PullRequestIn
    files: Annotated[list[FileIn], Field(min_length=1, max_length=MAX_FILES)]
    omitted_files: Annotated[list[OmittedFile], Field(default_factory=list, max_length=5_000)]


# ------------------------------------------------------------------ model output


class Finding(BaseModel):
    model_config = ConfigDict(extra="forbid")

    line: int | None
    severity: Severity
    category: Category
    explanation: Annotated[Text, StringConstraints(min_length=1, max_length=800)]
    suggestion: Annotated[Text, StringConstraints(max_length=800)]


class FileReview(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: Annotated[Text, StringConstraints(max_length=400)]
    findings: Annotated[list[Finding], Field(max_length=20)]


class MissingTest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    description: Annotated[Text, StringConstraints(min_length=1, max_length=400)]
    file: Annotated[Text, StringConstraints(max_length=500)] | None


class ReviewSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: Annotated[Text, StringConstraints(min_length=1, max_length=3_000)]
    missing_tests: Annotated[list[MissingTest], Field(max_length=10)]


FILE_SCHEMA = output_schema(FileReview, "review_file")
SUMMARY_SCHEMA = output_schema(ReviewSummary, "review_summary")


# ------------------------------------------------------------------ result


@dataclass(frozen=True)
class FileResult:
    path: str
    status: Literal["reviewed", "failed"]
    summary: str
    findings: list[Finding]
    # Findings whose line was not in the diff: kept, as file-level remarks.
    relocated: int = 0


@dataclass
class ReviewResult:
    summary: ReviewSummary
    files: list[FileResult]
    model: str
    usage: Usage = field(default_factory=lambda: Usage(0, 0))
    calls: int = 0


def _diff_for_prompt(patch: str) -> tuple[str, set[int], bool]:
    lines = parse_patch(patch)
    allowed = reviewable_lines(lines)
    text = numbered(lines)
    limit = FILE_DIFF_TOKENS * CHARS_PER_TOKEN
    if len(text) <= limit:
        return text, allowed, False
    cut = text[:limit].rsplit("\n", 1)[0]
    shown = {int(line[:5]) for line in cut.splitlines() if line[:5].strip().isdigit()}
    return cut, allowed & shown, True


def _validate_lines(findings: list[Finding], allowed: set[int]) -> tuple[list[Finding], int]:
    kept: list[Finding] = []
    relocated = 0
    seen: set[tuple[int | None, str]] = set()
    for finding in findings:
        if finding.line is not None and finding.line not in allowed:
            finding = finding.model_copy(update={"line": None})
            relocated += 1
        key = (finding.line, finding.explanation.casefold())
        if key in seen:
            continue
        seen.add(key)
        kept.append(finding)
    return kept, relocated


async def review(provider: ChatProvider, request: ReviewRequest) -> ReviewResult:
    pr = request.pull_request
    gate = asyncio.Semaphore(CONCURRENCY)
    result = ReviewResult(
        summary=ReviewSummary(summary="-", missing_tests=[]), files=[], model=provider.model
    )

    async def one(file: FileIn) -> FileResult:
        diff, allowed, truncated = _diff_for_prompt(file.patch)
        messages = PR_REVIEW_FILE.render(
            number=pr.number,
            repository=pr.repository,
            title=pr.title,
            body=pr.body or "(none)",
            path=file.path,
            status=file.status,
            additions=file.additions,
            deletions=file.deletions,
            truncated=truncated,
            diff=diff,
        )
        async with gate:
            try:
                generated = await generate(
                    provider, messages, FILE_SCHEMA, FileReview, FILE_MAX_OUTPUT_TOKENS
                )
            except InvalidOutputError as error:
                # One file the model could not review does not sink the others.
                result.usage += error.usage
                result.calls += 2
                return FileResult(file.path, "failed", "This file could not be reviewed.", [])
            except ProviderError as error:
                if error.retryable:
                    raise
                result.calls += 1
                return FileResult(file.path, "failed", "This file could not be reviewed.", [])
        result.usage += generated.usage
        result.calls += 2 if generated.repaired else 1
        result.model = generated.model
        findings, relocated = _validate_lines(generated.value.findings, allowed)
        return FileResult(file.path, "reviewed", generated.value.summary, findings, relocated)

    result.files = list(await asyncio.gather(*(one(f) for f in request.files)))

    files_json = json.dumps(
        [
            {
                "path": f.path,
                "status": f.status,
                "summary": f.summary,
                "findings": [
                    {
                        "line": x.line,
                        "severity": x.severity,
                        "category": x.category,
                        "explanation": x.explanation,
                    }
                    for x in f.findings
                ],
            }
            for f in result.files
        ],
        ensure_ascii=False,
    )
    messages = PR_REVIEW_SUMMARY.render(
        number=pr.number,
        repository=pr.repository,
        title=pr.title,
        body=pr.body or "(none)",
        omitted=[o.path for o in request.omitted_files[:50]],
        files_json=files_json,
    )
    summary = await generate(
        provider, messages, SUMMARY_SCHEMA, ReviewSummary, SUMMARY_MAX_OUTPUT_TOKENS
    )
    result.summary = summary.value
    result.usage += summary.usage
    result.calls += 2 if summary.repaired else 1
    result.model = summary.model
    return result


def sorted_findings(files: list[FileResult]) -> list[tuple[str, Finding]]:
    """Most severe first, then by file and line, as a reviewer would read them."""
    flat = [(f.path, x) for f in files for x in f.findings]
    return sorted(
        flat,
        key=lambda item: (SEVERITY_ORDER[item[1].severity], item[0], item[1].line or 0),
    )
