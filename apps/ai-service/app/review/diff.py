"""Unified diff parsing for one file's patch, as GitHub's pull request files API returns it.

The review prompt shows each line with its number in the new version of the file, and a finding
may only point at a line the pull request added or kept as context: a line number the model
invents (or one outside the diff) is dropped rather than shown as if it were real.
"""

import re
from dataclasses import dataclass
from typing import Literal

_HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")

LineKind = Literal["+", "-", " "]


@dataclass(frozen=True)
class DiffLine:
    kind: LineKind
    text: str
    # Number in the new file (None for removed lines).
    new_line: int | None


def parse_patch(patch: str) -> list[DiffLine]:
    lines: list[DiffLine] = []
    new_line = 0
    in_hunk = False
    for raw in patch.splitlines():
        header = _HUNK.match(raw)
        if header:
            new_line = int(header.group(2))
            in_hunk = True
            continue
        if not in_hunk or raw.startswith("\\"):  # "\ No newline at end of file"
            continue
        kind, text = (raw[0], raw[1:]) if raw else (" ", "")
        if kind == "+":
            lines.append(DiffLine("+", text, new_line))
            new_line += 1
        elif kind == "-":
            lines.append(DiffLine("-", text, None))
        else:
            lines.append(DiffLine(" ", text, new_line))
            new_line += 1
    return lines


def reviewable_lines(lines: list[DiffLine]) -> set[int]:
    """New-file line numbers a finding may point at: added lines and context."""
    return {line.new_line for line in lines if line.new_line is not None}


def numbered(lines: list[DiffLine]) -> str:
    """The diff as the model sees it: '  12 + code', with removed lines unnumbered."""
    out = []
    for line in lines:
        number = "" if line.new_line is None else str(line.new_line)
        out.append(f"{number:>5} {line.kind} {line.text}")
    return "\n".join(out)
