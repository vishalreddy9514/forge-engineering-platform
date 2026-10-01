"""Schema-constrained generation: stream, validate, and repair once if the output is invalid.

Strict structured outputs make invalid JSON rare, but not impossible (truncation, a refusal
turned into text, a provider without strict mode such as the fake). Output is never used
without validating it against the Pydantic model; one repair round tells the model exactly what
was wrong, and a second failure is an error rather than a guess.
"""

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass

from pydantic import BaseModel, ValidationError

from app.llm.base import (
    ChatProvider,
    Completion,
    Message,
    OutputSchema,
    TextDelta,
    Usage,
    complete,
)


class InvalidOutputError(Exception):
    """The model's output did not match the schema, even after one repair attempt."""

    def __init__(self, message: str, usage: Usage, model: str) -> None:
        super().__init__(message)
        self.usage = usage
        self.model = model


@dataclass(frozen=True)
class Generated[T: BaseModel]:
    value: T
    model: str
    usage: Usage
    repaired: bool


def parse[T: BaseModel](model: type[T], text: str) -> T:
    return model.model_validate(json.loads(text))


def _problem(error: Exception) -> str:
    if isinstance(error, ValidationError):
        return "; ".join(
            f"{'.'.join(str(p) for p in e['loc']) or 'root'}: {e['msg']}" for e in error.errors()
        )
    return str(error)


async def generate[T: BaseModel](
    provider: ChatProvider,
    messages: list[Message],
    schema: OutputSchema,
    model: type[T],
    max_output_tokens: int,
    first: Completion | None = None,
) -> Generated[T]:
    """Validated output. `first` is an already-streamed completion to validate before calling."""
    completion = first or await complete(provider, messages, schema, max_output_tokens)
    try:
        return Generated(parse(model, completion.text), completion.model, completion.usage, False)
    except (ValueError, ValidationError) as error:  # json.JSONDecodeError is a ValueError
        problem = _problem(error)

    repair: list[Message] = [
        *messages,
        {"role": "assistant", "content": completion.text},
        {
            "role": "user",
            "content": "That output does not match the required JSON schema: "
            f"{problem}. Reply again with only corrected JSON.",
        },
    ]
    second = await complete(provider, repair, schema, max_output_tokens)
    usage = completion.usage + second.usage
    try:
        return Generated(parse(model, second.text), second.model, usage, True)
    except (ValueError, ValidationError) as error:
        raise InvalidOutputError(
            f"The model's output was invalid twice: {_problem(error)}", usage, second.model
        ) from error


async def stream_then_validate[T: BaseModel](
    provider: ChatProvider,
    messages: list[Message],
    schema: OutputSchema,
    model: type[T],
    max_output_tokens: int,
) -> AsyncIterator[TextDelta | Generated[T]]:
    """Yields text deltas as they arrive, then the validated result (repairing if needed)."""
    completion: Completion | None = None
    async for event in provider.stream(messages, schema, max_output_tokens):
        if isinstance(event, TextDelta):
            yield event
        else:
            completion = event
    yield await generate(provider, messages, schema, model, max_output_tokens, first=completion)
