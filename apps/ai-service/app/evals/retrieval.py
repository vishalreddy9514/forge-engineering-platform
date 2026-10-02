"""Retrieval evaluation: hit-rate@k and MRR over a fixed corpus and question set (FR-8.6).

Each case is a question and the corpus documents that answer it. A case is a hit when any of
them is among the top k documents retrieval returns; its reciprocal rank is 1 / the rank of the
first one. The corpus mirrors the demo seed, written in the same normalised form the API
produces when it indexes issues, comments, pull requests and uploads.

With the fake embedder (CI) the eval checks that the pipeline is wired correctly (chunking,
storage, both halves of hybrid search, fusion, the project filter), not embedding quality: the
fake measures word overlap. Run it with the OpenAI embedder to measure quality before changing
chunking, the model or the fusion constants.
"""

import json
import uuid
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from app.rag.retriever import Retriever, best_per_document

EVALS = Path(__file__).resolve().parents[2] / "evals"
CORPUS = EVALS / "corpus.jsonl"
QUESTIONS = EVALS / "retrieval.jsonl"


@dataclass(frozen=True)
class CorpusDocument:
    id: str
    project: str
    source_type: str
    title: str
    content: str


@dataclass(frozen=True)
class Case:
    question: str
    expected: list[str]


@dataclass(frozen=True)
class CaseResult:
    case: Case
    retrieved: list[str]

    @property
    def rank(self) -> int | None:
        for position, doc in enumerate(self.retrieved, start=1):
            if doc in self.case.expected:
                return position
        return None


@dataclass
class Report:
    k: int
    results: list[CaseResult] = field(default_factory=list)

    @property
    def hit_rate(self) -> float:
        hits = sum(1 for r in self.results if r.rank is not None)
        return hits / len(self.results) if self.results else 0.0

    @property
    def mrr(self) -> float:
        total = sum(1 / r.rank for r in self.results if r.rank is not None)
        return total / len(self.results) if self.results else 0.0

    def misses(self) -> list[CaseResult]:
        return [r for r in self.results if r.rank is None]

    def summary(self) -> str:
        lines = [
            f"retrieval eval: {len(self.results)} questions, "
            f"hit-rate@{self.k} = {self.hit_rate:.3f}, MRR = {self.mrr:.3f}"
        ]
        for miss in self.misses():
            lines.append(
                f"  MISS {miss.case.question!r}: expected {miss.case.expected}, "
                f"got {miss.retrieved}"
            )
        return "\n".join(lines)


def load_corpus(path: Path = CORPUS) -> list[CorpusDocument]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return [
        CorpusDocument(r["id"], r["project"], r["sourceType"], r["title"], r["content"])
        for r in rows
    ]


def load_cases(path: Path = QUESTIONS) -> list[Case]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    return [Case(r["question"], r["expected"]) for r in rows]


async def evaluate(
    retriever: Retriever,
    cases: list[Case],
    project_ids: list[uuid.UUID],
    corpus_ids: Mapping[uuid.UUID, str],
    k: int = 5,
) -> Report:
    """Runs every question through hybrid retrieval as a user who can read all `project_ids`.
    `corpus_ids` maps stored document IDs back to corpus IDs."""
    report = Report(k)
    for case in cases:
        ranked, _ = await retriever.retrieve(case.question, project_ids)
        top = best_per_document(ranked)[:k]
        report.results.append(
            CaseResult(case, [corpus_ids.get(r.hit.document_id, "?") for r in top])
        )
    return report
