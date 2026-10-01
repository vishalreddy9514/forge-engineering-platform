"""Embedding providers: OpenAI in deployed environments, a deterministic fake everywhere else.

Vectors are 1536-dimensional (the document_chunks.embedding column) and L2-normalised, so cosine
similarity is a dot product. Each vector is stored with the model that produced it; changing the
model makes every stored chunk stale, and re-indexing re-embeds it.
"""

import hashlib
import math
import re
from dataclasses import dataclass
from itertools import pairwise
from typing import Protocol

import openai
from openai import AsyncOpenAI

from app.llm.openai_provider import provider_error
from app.llm.tokens import estimate_tokens, truncate_to_tokens

DIMENSIONS = 1536
# OpenAI accepts up to 2048 inputs per request; smaller batches keep one failure cheap.
BATCH_SIZE = 128
# text-embedding-3-small reads at most 8191 tokens per input; chunks are far smaller, but a
# query or draft text is capped here too.
MAX_INPUT_TOKENS = 8_000


@dataclass(frozen=True)
class Embeddings:
    vectors: list[list[float]]
    model: str
    input_tokens: int


class EmbeddingProvider(Protocol):
    model: str
    # Cosine similarity above which two issues count as related (FR-7.3). Scales differ between
    # models, so the threshold belongs to the model, and RELATED_MIN_SCORE can override it.
    related_threshold: float

    async def embed(self, texts: list[str]) -> Embeddings: ...


class OpenAIEmbedder:
    related_threshold = 0.55

    def __init__(self, client: AsyncOpenAI, model: str) -> None:
        self._client = client
        self.model = model

    async def embed(self, texts: list[str]) -> Embeddings:
        vectors: list[list[float]] = []
        tokens = 0
        for start in range(0, len(texts), BATCH_SIZE):
            batch = [
                truncate_to_tokens(t, MAX_INPUT_TOKENS) for t in texts[start : start + BATCH_SIZE]
            ]
            try:
                response = await self._client.embeddings.create(
                    model=self.model, input=batch, dimensions=DIMENSIONS
                )
            except openai.OpenAIError as error:
                raise provider_error(error) from error
            ordered = sorted(response.data, key=lambda item: item.index)
            vectors.extend(item.embedding for item in ordered)
            tokens += response.usage.prompt_tokens
        return Embeddings(vectors, self.model, tokens)


_WORD = re.compile(r"[a-z0-9]+(?:[-_][a-z0-9]+)*")
_STOPWORDS_TEXT = """a an and are as at be but by can do does for from has have how i if in
    into is it its
    me my no not of on or our so that the their them then there these they this to was we were
    what when where which who why will with you your"""
_STOPWORDS = frozenset(_STOPWORDS_TEXT.split())
_SUFFIXES = ("ing", "ed", "es", "ly", "s")


def _stem(word: str) -> str:
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"  # retries → retry, like retrying → retry
    for suffix in _SUFFIXES:
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            return word[: -len(suffix)]
    return word


def _features(text: str) -> list[tuple[str, float]]:
    words = [w for w in _WORD.findall(text.lower()) if w not in _STOPWORDS]
    stems = [_stem(w) for w in words]
    features: list[tuple[str, float]] = [(f"w:{s}", 1.0) for s in stems]
    # Parts of compound tokens (stripe_webhook, PAY-12) also count on their own.
    for word in words:
        parts = re.split(r"[-_]", word)
        if len(parts) > 1:
            features.extend((f"w:{_stem(p)}", 0.5) for p in parts if p and p not in _STOPWORDS)
    features.extend((f"b:{a} {b}", 0.5) for a, b in pairwise(stems))
    return features


def fake_vector(text: str) -> list[float]:
    """Feature hashing of stemmed words and word pairs into 1536 signed dimensions."""
    vector = [0.0] * DIMENSIONS
    for feature, weight in _features(text):
        digest = hashlib.blake2b(feature.encode(), digest_size=8).digest()
        index = int.from_bytes(digest[:4], "big") % DIMENSIONS
        sign = 1.0 if digest[4] & 1 else -1.0
        vector[index] += sign * weight
    norm = math.sqrt(sum(v * v for v in vector))
    if norm == 0:
        # Text with no words (only punctuation) still needs a valid unit vector.
        vector[0] = 1.0
        return vector
    return [v / norm for v in vector]


class FakeEmbedder:
    """Deterministic stand-in (architecture §7.1): similar wording gives similar vectors, so
    retrieval, related issues and the eval exercise the real pipeline without an API key. It
    measures lexical overlap, not meaning; embedding quality is measured with the real model."""

    model = "fake-embedding-1"
    related_threshold = 0.3

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    async def embed(self, texts: list[str]) -> Embeddings:
        self.calls.append(texts)
        tokens = sum(estimate_tokens(t) for t in texts)
        return Embeddings([fake_vector(t) for t in texts], self.model, tokens)
