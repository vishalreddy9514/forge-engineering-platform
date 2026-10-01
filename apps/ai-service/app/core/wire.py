from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class Wire(BaseModel):
    """Request and response bodies exchanged with the API: camelCase JSON like the rest of
    Forge, snake_case in Python. Unknown fields are rejected."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
    )
