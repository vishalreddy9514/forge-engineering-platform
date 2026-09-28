"""Turns a Pydantic model into the JSON Schema dialect OpenAI's strict structured outputs accept."""

from typing import Any

from pydantic import BaseModel

from app.llm.base import OutputSchema

# Validation keywords strict mode rejects or ignores. They stay enforced locally: the reply is
# always validated with the Pydantic model, so the model cannot get around them.
_LOCAL_ONLY = {"minLength", "maxLength", "minItems", "maxItems", "pattern", "format", "default"}


def output_schema(model: type[BaseModel], name: str) -> OutputSchema:
    return OutputSchema(name=name, schema=strict_schema(model.model_json_schema()))


def strict_schema(node: Any) -> Any:
    """Every object closed (`additionalProperties: false`) with every property required, titles
    and local-only keywords removed, recursively (including `$defs`)."""
    if isinstance(node, list):
        return [strict_schema(item) for item in node]
    if not isinstance(node, dict):
        return node
    out = {
        key: strict_schema(value)
        for key, value in node.items()
        if key not in _LOCAL_ONLY and key != "title"
    }
    if out.get("type") == "object" and "properties" in out:
        out["additionalProperties"] = False
        out["required"] = list(out["properties"])
    return out
