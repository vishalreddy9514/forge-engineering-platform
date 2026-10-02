"""Source-aware chunking (architecture §7.2).

Issues, comments, pull requests and commits are short and meaningful as a whole, so each is one
chunk unless it is long. Uploaded documents are split along their Markdown heading hierarchy and
packed into windows of about 500 tokens with 50 tokens of overlap, keeping the heading path
("Setup > Database") for citations and for the keyword index.

The API writes the normalised text (header lines such as "Issue PAY-12: …" included), so the
chunker never needs to know how a source is stored.
"""

import hashlib
import re
from dataclasses import dataclass
from typing import Literal

from app.llm.tokens import CHARS_PER_TOKEN, estimate_tokens

SourceType = Literal["ISSUE", "COMMENT", "PULL_REQUEST", "COMMIT", "UPLOAD"]

# A short source stays whole below this size; above it, it is split like a document.
WHOLE_SOURCE_MAX_TOKENS = 800
TARGET_TOKENS = 500
OVERLAP_TOKENS = 50
# Guards against a pathological upload turning into an unbounded embedding bill.
MAX_CHUNKS_PER_DOCUMENT = 2_000

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
_FENCE = re.compile(r"^\s*(```|~~~)")


@dataclass(frozen=True)
class Chunk:
    index: int
    content: str
    heading_path: str | None
    token_count: int
    content_hash: str

    def embedding_input(self, title: str) -> str:
        """What is embedded: the chunk with its document title and section for context."""
        return embedding_input(title, self.heading_path, self.content)


def embedding_input(title: str, heading_path: str | None, content: str) -> str:
    lines = [title]
    if heading_path:
        lines.append(heading_path)
    return "\n".join(lines) + "\n\n" + content


@dataclass(frozen=True)
class _Section:
    path: tuple[str, ...]
    text: str


class TooManyChunksError(ValueError):
    pass


def chunk_document(source_type: SourceType, title: str, content: str) -> list[Chunk]:
    text = _normalise(content)
    if not text:
        return []
    if source_type != "UPLOAD" and estimate_tokens(text) <= WHOLE_SOURCE_MAX_TOKENS:
        pieces: list[tuple[str | None, str]] = [(None, text)]
    else:
        pieces = []
        for section in _sections(text):
            path = " > ".join(section.path) or None
            pieces.extend((path, window) for window in _windows(section.text))
    if len(pieces) > MAX_CHUNKS_PER_DOCUMENT:
        raise TooManyChunksError(
            f"The document would produce {len(pieces)} chunks; the limit is "
            f"{MAX_CHUNKS_PER_DOCUMENT}"
        )
    return [
        Chunk(
            index=index,
            content=body,
            heading_path=path,
            token_count=max(estimate_tokens(body), 1),
            # The hash covers everything that is embedded, so a renamed document re-embeds.
            content_hash=_sha256(embedding_input(title, path, body)),
        )
        for index, (path, body) in enumerate(pieces)
    ]


def _normalise(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")
    lines = [line.rstrip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _sections(text: str) -> list[_Section]:
    """Splits on Markdown headings (not inside code fences), tracking the heading path."""
    sections: list[_Section] = []
    path: list[tuple[int, str]] = []
    current: list[str] = []
    in_fence = False

    def flush() -> None:
        body = "\n".join(current).strip()
        if body:
            sections.append(_Section(tuple(name for _, name in path), body))
        current.clear()

    for line in text.split("\n"):
        if _FENCE.match(line):
            in_fence = not in_fence
        heading = None if in_fence else _HEADING.match(line)
        if heading:
            flush()
            level = len(heading.group(1))
            while path and path[-1][0] >= level:
                path.pop()
            path.append((level, heading.group(2).strip()[:200]))
            continue
        current.append(line)
    flush()
    return sections


def _windows(text: str) -> list[str]:
    """Packs paragraphs into windows of about TARGET_TOKENS, repeating about OVERLAP_TOKENS of
    the previous window's end at the start of the next, so a sentence that straddles a boundary
    is retrievable from either side."""
    target = TARGET_TOKENS * CHARS_PER_TOKEN
    overlap = OVERLAP_TOKENS * CHARS_PER_TOKEN
    units: list[str] = []
    for paragraph in text.split("\n\n"):
        units.extend(_split_long(paragraph.strip(), target))

    windows: list[str] = []
    current = ""
    for unit in units:
        if not unit:
            continue
        candidate = f"{current}\n\n{unit}" if current else unit
        if len(candidate) <= target or not current:
            current = candidate
            continue
        windows.append(current)
        current = f"{_tail(current, overlap)}\n\n{unit}"
    if current:
        windows.append(current)
    return windows


def _split_long(paragraph: str, limit: int) -> list[str]:
    """A paragraph longer than a window is cut at word boundaries."""
    if len(paragraph) <= limit:
        return [paragraph]
    parts: list[str] = []
    words = paragraph.split(" ")
    current = ""
    for word in words:
        while len(word) > limit:  # a single unbroken token (a minified line, a base64 blob)
            if current:
                parts.append(current)
                current = ""
            parts.append(word[:limit])
            word = word[limit:]
        candidate = f"{current} {word}" if current else word
        if len(candidate) > limit:
            parts.append(current)
            current = word
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts


def _tail(text: str, size: int) -> str:
    """The last `size` characters, starting at a word boundary."""
    if len(text) <= size:
        return text
    tail = text[-size:]
    space = tail.find(" ")
    return tail[space + 1 :] if 0 <= space < len(tail) - 1 else tail
