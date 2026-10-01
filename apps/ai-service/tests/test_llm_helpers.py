from decimal import Decimal

import pytest

from app.features.drafts import DRAFT_SCHEMA
from app.features.summaries import SUMMARY_SCHEMA
from app.llm.base import Usage
from app.llm.pricing import estimate_cost
from app.llm.schema import strict_schema
from app.llm.tokens import estimate_tokens, truncate_to_tokens


def test_strict_schema_closes_every_object_and_requires_every_property() -> None:
    schema = strict_schema(
        {
            "title": "Outer",
            "type": "object",
            "properties": {
                "name": {"type": "string", "minLength": 3, "title": "Name"},
                "inner": {"$ref": "#/$defs/Inner"},
            },
            "required": ["name"],
            "$defs": {
                "Inner": {
                    "type": "object",
                    "properties": {"n": {"type": "integer"}},
                }
            },
        }
    )
    assert schema == {
        "type": "object",
        "properties": {"name": {"type": "string"}, "inner": {"$ref": "#/$defs/Inner"}},
        "required": ["name", "inner"],
        "additionalProperties": False,
        "$defs": {
            "Inner": {
                "type": "object",
                "properties": {"n": {"type": "integer"}},
                "additionalProperties": False,
                "required": ["n"],
            }
        },
    }


@pytest.mark.parametrize("schema", [DRAFT_SCHEMA, SUMMARY_SCHEMA])
def test_feature_schemas_are_strict_mode_compatible(schema: object) -> None:
    text = repr(schema)
    for keyword in ("minLength", "maxLength", "minItems", "maxItems", "'title'"):
        assert keyword not in text


def test_token_estimates_and_truncation() -> None:
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("abcde") == 2
    assert truncate_to_tokens("short", 10) == "short"
    cut = truncate_to_tokens("x" * 100, 5)
    assert len(cut) == 20
    assert cut.endswith("…")


def test_cost_uses_the_price_table_and_dated_snapshots() -> None:
    usage = Usage(input_tokens=1_000_000, output_tokens=500_000)
    assert estimate_cost("gpt-4.1-mini", usage) == Decimal("1.200000")
    assert estimate_cost("gpt-4.1-mini-2025-04-14", usage) == Decimal("1.200000")
    assert estimate_cost("fake", usage) == 0
    assert estimate_cost("some-future-model", usage) == 0
