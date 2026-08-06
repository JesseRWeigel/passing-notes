"""Apply one sabotage to a copy of the tree, and refuse to pretend when it did not apply.

A separate file rather than a heredoc inside verify.sh. Python nested inside bash nested inside a
heredoc fails to parse in ways that produce no error and no edit, so the sabotage silently never
applies and the harness reports that nothing broke. That reads exactly like a passing test.

Exits 0 only when the pattern was found, was different from its replacement, and the file on disk
actually changed.

    python3 scripts/patch.py <file> <old> <new>
"""
from __future__ import annotations

import sys


def main(path: str, old: str, new: str) -> int:
    if old == new:
        print("SABOTAGE IS A NO-OP: the replacement is identical to the pattern")
        return 1
    with open(path, encoding="utf-8") as fh:
        text = fh.read()
    if old not in text:
        print(f"SABOTAGE DID NOT APPLY: pattern absent from {path}")
        print(f"  looked for: {old!r}")
        return 1
    if text.count(old) > 1:
        print(f"SABOTAGE IS AMBIGUOUS: pattern appears {text.count(old)} times in {path}")
        return 1
    patched = text.replace(old, new, 1)
    if patched == text:
        print("SABOTAGE CHANGED NOTHING despite matching, which should be impossible")
        return 1
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(patched)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2], sys.argv[3]))
