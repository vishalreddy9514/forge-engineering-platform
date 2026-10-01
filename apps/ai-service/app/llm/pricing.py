"""Estimated cost per call, recorded in ai_usage (NFR-12). Prices are USD per million tokens and
must be updated when the provider changes them; an unknown model is costed at zero and logged."""

from decimal import Decimal

import structlog

from app.llm.base import Usage

_log = structlog.get_logger(__name__)

# model: (input, output) USD per 1M tokens
PRICES: dict[str, tuple[Decimal, Decimal]] = {
    "gpt-4.1": (Decimal("2.00"), Decimal("8.00")),
    "gpt-4.1-mini": (Decimal("0.40"), Decimal("1.60")),
    "gpt-4.1-nano": (Decimal("0.10"), Decimal("0.40")),
    "gpt-4o-mini": (Decimal("0.15"), Decimal("0.60")),
    "fake": (Decimal(0), Decimal(0)),
}

_MILLION = Decimal(1_000_000)


def estimate_cost(model: str, usage: Usage) -> Decimal:
    # Providers report dated snapshots ("gpt-4.1-mini-2025-04-14"); price by the family name,
    # the longest that matches ("gpt-4.1-mini", not "gpt-4.1").
    family = max((name for name in PRICES if model.startswith(f"{name}-")), key=len, default=None)
    price = PRICES.get(model) or (PRICES[family] if family else None)
    if price is None:
        _log.warning("no price for model; cost recorded as 0", model=model)
        return Decimal(0)
    cost = (usage.input_tokens * price[0] + usage.output_tokens * price[1]) / _MILLION
    return cost.quantize(Decimal("0.000001"))
