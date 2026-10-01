"""Token estimates for budgeting prompts.

A character-based estimate (about four characters per token for English and code) rather than an
exact tokenizer: exact tokenizers download vocabularies at runtime, and budgets only need to be
conservative. Billing uses the provider's reported usage, never this estimate.
"""

import math

CHARS_PER_TOKEN = 4


def estimate_tokens(text: str) -> int:
    return math.ceil(len(text) / CHARS_PER_TOKEN)


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    limit = max_tokens * CHARS_PER_TOKEN
    return text if len(text) <= limit else text[: max(limit - 1, 0)] + "…"
