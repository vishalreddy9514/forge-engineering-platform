"""FR-7 endpoints. The API calls these with the service token; users never reach them directly."""

from collections.abc import AsyncIterator
from typing import Any

import structlog
from fastapi import APIRouter, HTTPException, status
from fastapi.responses import StreamingResponse

from app.api.deps import AppSettings, Provider
from app.api.schemas import UsageOut, camel
from app.api.streaming import SSE_HEADERS, sse
from app.core.wire import Wire
from app.features import drafts, reviews, summaries
from app.features.structured import Generated, InvalidOutputError, generate, stream_then_validate
from app.llm.base import ProviderError, TextDelta, Usage
from app.prompts import PR_REVIEW_FILE

router = APIRouter(tags=["features"])
_log = structlog.get_logger(__name__)


@router.post("/drafts")
async def create_draft(body: drafts.DraftRequest, provider: Provider) -> StreamingResponse:
    """Streams `delta` events while the model writes, then one `result` (the validated draft)
    or one `error`. Every terminal event carries usage, so failed calls are costed too."""
    version, messages = drafts.prompt_for(body)

    async def events() -> AsyncIterator[bytes]:
        try:
            async for event in stream_then_validate(
                provider,
                messages,
                drafts.DRAFT_SCHEMA,
                drafts.IssueDraft,
                drafts.DRAFT_MAX_OUTPUT_TOKENS,
            ):
                if isinstance(event, TextDelta):
                    yield sse("delta", {"text": event.text})
                else:
                    yield sse("result", _draft_result(event, body.labels, version))
        except InvalidOutputError as error:
            yield sse("error", _error("invalid_output", str(error), error.model, error.usage))
        except ProviderError as error:
            _log.warning("draft failed", error=str(error), retryable=error.retryable)
            code = "provider_unavailable" if error.retryable else "provider_error"
            # A failed provider call is not billed; nothing was produced.
            yield sse("error", _error(code, str(error), provider.model, Usage(0, 0)))

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers=SSE_HEADERS,
    )


def _draft_result(
    generated: Generated[drafts.IssueDraft], allowed: list[str], version: str
) -> dict[str, Any]:
    draft, dropped = drafts.keep_known_labels(generated.value, allowed)
    return {
        "draft": camel(draft.model_dump()),
        "droppedLabels": dropped,
        "model": generated.model,
        "promptVersion": version,
        "repaired": generated.repaired,
        "usage": UsageOut.of(generated.model, generated.usage).model_dump(mode="json"),
    }


def _error(code: str, message: str, model: str, usage: Usage) -> dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "model": model,
        "usage": UsageOut.of(model, usage).model_dump(mode="json"),
    }


class SummaryOut(Wire):
    summary: dict[str, Any]
    model: str
    prompt_version: str
    repaired: bool
    omitted_comments: int
    usage: UsageOut


@router.post("/summaries")
async def create_summary(
    body: summaries.SummaryRequest, provider: Provider, settings: AppSettings
) -> SummaryOut:
    version, messages, omitted = summaries.prompt_for(body, settings.max_input_tokens)
    try:
        generated = await generate(
            provider,
            messages,
            summaries.SUMMARY_SCHEMA,
            summaries.ThreadSummary,
            summaries.SUMMARY_MAX_OUTPUT_TOKENS,
        )
    except InvalidOutputError as error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(error)) from error
    except ProviderError as error:
        code = status.HTTP_503_SERVICE_UNAVAILABLE if error.retryable else 502
        raise HTTPException(code, str(error)) from error
    return SummaryOut(
        summary=camel(generated.value.model_dump()),
        model=generated.model,
        prompt_version=version,
        repaired=generated.repaired,
        omitted_comments=omitted,
        usage=UsageOut.of(generated.model, generated.usage),
    )


class FindingOut(Wire):
    file: str
    line: int | None
    severity: str
    category: str
    explanation: str
    suggestion: str


class MissingTestOut(Wire):
    description: str
    file: str | None


class ReviewedFileOut(Wire):
    path: str
    status: str
    summary: str
    findings: int


class ReviewOut(Wire):
    summary: str
    findings: list[FindingOut]
    missing_tests: list[MissingTestOut]
    files: list[ReviewedFileOut]
    model: str
    prompt_version: str
    calls: int
    usage: UsageOut


@router.post("/reviews")
async def create_review(body: reviews.ReviewRequest, provider: Provider) -> ReviewOut:
    """FR-9.2. Runs to completion (the API calls this from a background job): one structured
    review per file, in parallel, then a summary. 503 means retry later; 502 means the model's
    output could not be used."""
    try:
        result = await reviews.review(provider, body)
    except InvalidOutputError as error:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(error)) from error
    except ProviderError as error:
        code = status.HTTP_503_SERVICE_UNAVAILABLE if error.retryable else 502
        raise HTTPException(code, str(error)) from error
    return ReviewOut(
        summary=result.summary.summary,
        findings=[
            FindingOut(file=path, **finding.model_dump())
            for path, finding in reviews.sorted_findings(result.files)
        ],
        missing_tests=[MissingTestOut(**t.model_dump()) for t in result.summary.missing_tests],
        files=[
            ReviewedFileOut(
                path=f.path, status=f.status, summary=f.summary, findings=len(f.findings)
            )
            for f in result.files
        ],
        model=result.model,
        prompt_version=PR_REVIEW_FILE.version,
        calls=result.calls,
        usage=UsageOut.of(result.model, result.usage),
    )
