from itertools import pairwise

import pytest

from app.llm.tokens import estimate_tokens
from app.rag import chunking
from app.rag.chunking import TooManyChunksError, chunk_document


def test_a_short_issue_is_one_chunk() -> None:
    chunks = chunk_document("ISSUE", "PAY-1", "Issue PAY-1: Double charge\n\nDetails.")
    assert len(chunks) == 1
    assert chunks[0].content == "Issue PAY-1: Double charge\n\nDetails."
    assert chunks[0].heading_path is None
    assert chunks[0].index == 0


def test_empty_content_has_no_chunks() -> None:
    assert chunk_document("COMMENT", "x", " \n\n ") == []


def test_documents_split_along_their_heading_hierarchy() -> None:
    text = (
        "# Guide\n\nIntro.\n\n## Setup\n\nInstall it.\n\n### Database\n\nRun migrations.\n\n"
        "## Usage\n\nCall it."
    )
    chunks = chunk_document("UPLOAD", "Guide", text)
    assert [(c.heading_path, c.content) for c in chunks] == [
        ("Guide", "Intro."),
        ("Guide > Setup", "Install it."),
        ("Guide > Setup > Database", "Run migrations."),
        ("Guide > Usage", "Call it."),
    ]


def test_headings_inside_code_fences_are_not_headings() -> None:
    text = "## Script\n\n```sh\n# not a heading\necho hi\n```"
    chunks = chunk_document("UPLOAD", "Doc", text)
    assert len(chunks) == 1
    assert chunks[0].heading_path == "Script"
    assert "# not a heading" in chunks[0].content


def test_long_sections_are_windowed_with_overlap() -> None:
    paragraphs = [f"Paragraph {i} " + "word " * 120 for i in range(12)]
    chunks = chunk_document("UPLOAD", "Doc", "## Big\n\n" + "\n\n".join(paragraphs))

    assert len(chunks) > 2
    assert all(
        c.token_count <= chunking.TARGET_TOKENS + chunking.OVERLAP_TOKENS + 10 for c in chunks
    )
    # Each window starts with the end of the previous one.
    for previous, current in pairwise(chunks):
        assert previous.content[-60:].split()[-1] in current.content[:400]
    assert all(c.heading_path == "Big" for c in chunks)


def test_a_long_issue_is_split_but_a_short_one_is_not() -> None:
    long_issue = "Issue X-1: t\n\n" + "\n\n".join("word " * 150 for _ in range(10))
    assert estimate_tokens(long_issue) > chunking.WHOLE_SOURCE_MAX_TOKENS
    assert len(chunk_document("ISSUE", "X-1", long_issue)) > 1


def test_an_unbroken_token_longer_than_a_window_is_cut() -> None:
    blob = "a" * 5000
    chunks = chunk_document("UPLOAD", "Doc", blob)
    assert "".join(c.content for c in chunks).replace("\n", "").count("a") >= 5000
    assert all(
        len(c.content) <= chunking.TARGET_TOKENS * 4 + chunking.OVERLAP_TOKENS * 4 + 2
        for c in chunks
    )


def test_the_hash_covers_title_section_and_text() -> None:
    one = chunk_document("UPLOAD", "Doc", "## A\n\ntext")[0]
    renamed = chunk_document("UPLOAD", "Renamed", "## A\n\ntext")[0]
    moved = chunk_document("UPLOAD", "Doc", "## B\n\ntext")[0]
    same = chunk_document("UPLOAD", "Doc", "## A\r\n\r\ntext  ")[0]
    assert len({one.content_hash, renamed.content_hash, moved.content_hash}) == 3
    assert same.content_hash == one.content_hash  # line endings and trailing space normalised


def test_embedding_input_includes_title_and_section() -> None:
    chunk = chunk_document("UPLOAD", "Runbook", "## Webhooks\n\nDedupe by event ID.")[0]
    assert chunk.embedding_input("Runbook") == "Runbook\nWebhooks\n\nDedupe by event ID."


def test_a_pathological_document_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(chunking, "MAX_CHUNKS_PER_DOCUMENT", 3)
    text = "\n\n".join(f"## S{i}\n\nbody" for i in range(4))
    with pytest.raises(TooManyChunksError):
        chunk_document("UPLOAD", "Doc", text)
