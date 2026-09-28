"""Wire format shared with the API: camelCase JSON, like the rest of Forge."""

from decimal import Decimal
from typing import Any

from pydantic.alias_generators import to_camel

from app.core.wire import Wire
from app.llm.base import Usage
from app.llm.pricing import estimate_cost


class UsageOut(Wire):
    input_tokens: int
    output_tokens: int
    cost_usd: Decimal

    @classmethod
    def of(cls, model: str, usage: Usage) -> "UsageOut":
        return cls(
            input_tokens=usage.input_tokens,
            output_tokens=usage.output_tokens,
            cost_usd=estimate_cost(model, usage),
        )


def camel(value: dict[str, Any]) -> dict[str, Any]:
    return {to_camel(key): item for key, item in value.items()}
