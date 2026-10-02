"""FR-8.6: the retrieval eval as a CI gate (hit-rate@5 must be at least 0.8).

Runs on the fake embedder by default. For a quality measurement with real embeddings:

    EVAL_EMBEDDER=openai OPENAI_API_KEY=... TEST_DATABASE_ADMIN_URL=... \\
        uv run pytest tests/test_eval.py -s
"""

import os
import uuid

from app.core.config import Settings
from app.evals.retrieval import evaluate, load_cases, load_corpus
from app.llm.factory import build_embedder
from app.rag.embedder import EmbeddingProvider, FakeEmbedder
from app.rag.indexer import index_document
from app.rag.retriever import Retriever
from app.rag.store import Store
from tests.db import Fixtures

HIT_RATE_GATE = 0.8


def embedder() -> EmbeddingProvider:
    if os.environ.get("EVAL_EMBEDDER") == "openai":
        return build_embedder(Settings(provider="openai"))  # key and model from the environment
    return FakeEmbedder()


async def test_retrieval_hit_rate_at_5(store: Store, fixtures: Fixtures) -> None:
    corpus = load_corpus()
    cases = load_cases()
    assert len(cases) >= 40
    known = {doc.id for doc in corpus}
    assert all(set(case.expected) <= known for case in cases), "expected IDs must exist"

    # Fresh keys: the scratch database is shared by the whole session.
    suffix = uuid.uuid4().hex[:4].upper()
    projects = {key: fixtures.project(f"{key[:4]}{suffix}") for key in {d.project for d in corpus}}
    corpus_ids: dict[uuid.UUID, str] = {}
    embed = embedder()
    for doc in corpus:
        document_id, _ = fixtures.document(
            projects[doc.project], doc.title, doc.content, source_type=doc.source_type
        )
        corpus_ids[document_id] = doc.id
        result = await index_document(store, embed, document_id)
        assert result.status == "indexed"

    report = await evaluate(Retriever(store, embed), cases, list(projects.values()), corpus_ids)

    print("\n" + report.summary())  # visible with -s and in CI logs on failure
    assert report.hit_rate >= HIT_RATE_GATE, report.summary()
