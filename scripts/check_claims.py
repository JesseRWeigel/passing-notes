#!/usr/bin/env python3
"""Check that every number the README states is a number something actually measured.

A pasted "49 tests passed" goes stale the moment somebody adds a test, and a pasted "the longest
link we saw was 42 characters" goes stale the moment the encoder changes. Both then sit in the
README looking authoritative. This reads the claims back out of the prose and compares each one
against results/*.json, which are written by the scripts that did the measuring.

Every claim below is anchored on a distinctive phrase in the README, so a claim that gets
reworded fails loudly rather than silently ceasing to be checked. That matters more than it
sounds: a check that quietly stops checking reports the same success as one that ran.

    python3 scripts/check_claims.py
"""
from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


WRITERS = {
    "measurements.json": "node scripts/measure.mjs",
    "attacks.json": "node scripts/attack_url.mjs",
    "browser.json": "node scripts/browser_play.mjs",
    "sabotage.json": "python3 scripts/sabotage.py --json results/sabotage.json",
}


def load(name):
    """results/ is derived output and is not committed, so say how to make it rather than
    failing with a bare traceback that looks like a bug in this script."""
    path = os.path.join(ROOT, "results", name)
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        raise SystemExit(
            f"        results/{name} does not exist yet. Produce it with:\n"
            f"            {WRITERS.get(name, 'bash scripts/verify.sh')}\n"
            f"        or run the whole thing with: bash scripts/verify.sh"
        )


def main() -> int:
    with open(os.path.join(ROOT, "README.md"), encoding="utf-8") as handle:
        readme = handle.read()

    measurements = load("measurements.json")
    attacks = load("attacks.json")
    browser = load("browser.json")
    sabotage = load("sabotage.json")

    caught = sum(1 for s in sabotage["sabotages"] if s.get("gate3"))

    # (label, regex with one capturing group, the value it has to equal)
    claims = [
        (
            "the proven code-length ceiling",
            r"cannot exceed \*\*(\d+) characters\*\*",
            measurements["bound"]["chars"],
        ),
        (
            "the proven ceiling in bits",
            r"\*\*(\d+) bits\*\* of choice",
            measurements["bound"]["bits"],
        ),
        (
            "the worst-case whole link",
            r"worst possible link is\s+\*\*(\d+) characters\*\*",
            measurements["bound"]["chars"] + measurements["link"]["overheadChars"],
        ),
        (
            "the longest code actually observed",
            r"longest was \*\*(\d+) characters\*\*",
            measurements["observed"]["longest"]["chars"],
        ),
        (
            "how many games were sampled",
            r"[Aa]cross \*\*([\d,]+) simulated games\*\*",
            measurements["games"],
        ),
        (
            "characters added per decision",
            r"about \*\*([\d.]+) characters\*\* per recorded decision",
            attacks["length"]["charsPerDecision"],
        ),
        (
            "single-character edits refused",
            r"all \*\*([\d,]+)\*\* of them were refused",
            attacks["oneCharacterChanged"]["refused"],
        ),
        (
            "truncations tried",
            r"\*\*([\d,]+) truncated prefixes\*\*",
            attacks["truncation"]["prefixes"],
        ),
        (
            "truncations that slipped through",
            r"\*\*(\d+)\*\* of them decoded into a different legal game",
            attacks["truncation"]["silentlyAccepted"],
        ),
        (
            "invented games accepted",
            r"\*\*(\d+) of \d+\*\* invented games were accepted",
            attacks["forgery"]["encodeAnyGameYouLike"]["accepted"],
        ),
        (
            "browser checks",
            r"\*\*(\d+) checks\*\* in headless Chromium",
            browser_check_count(),
        ),
        (
            "sabotages caught",
            r"\*\*(\d+) of \d+ sabotages\*\*",
            caught,
        ),
        (
            "sabotages attempted",
            r"\*\*\d+ of (\d+) sabotages\*\*",
            len(sabotage["sabotages"]),
        ),
        (
            "the RTC handshake blob",
            r"handshake blobs are around \*\*(\d+)\*\*",
            round(browser["rtc"]["offerChars"], -1),
        ),
        (
            "plies re-derived rather than sent",
            r"\*\*([\d.]+)%\*\* of\s+all plies",
            round(measurements["observed"]["derivedPlyFraction"] * 100, 1),
        ),
        (
            "the unit test count",
            r"\*\*(\d+) unit tests\*\*",
            expected_test_count(),
        ),
    ]

    problems = []
    for label, pattern, want in claims:
        found = re.search(pattern, readme)
        if not found:
            problems.append(f"{label}: the README no longer contains a claim matching /{pattern}/")
            continue
        raw = found.group(1).replace(",", "")
        got = float(raw) if "." in raw else int(raw)
        if got != want:
            problems.append(f"{label}: the README says {found.group(1)}, the measurement says {want}")

    print(f"        {len(claims)} numeric claims in the README, checked against results/*.json")
    for problem in problems:
        print(f"        {problem}")
    return 1 if problems else 0


def counted(name, how):
    """A count that scripts/verify.sh recorded from a real run of the thing being counted."""
    path = os.path.join(ROOT, "results", name)
    try:
        with open(path, encoding="utf-8") as handle:
            return int(handle.read().strip())
    except FileNotFoundError:
        raise SystemExit(
            f"        results/{name} does not exist yet. It is written by scripts/verify.sh\n"
            f"        when it runs {how}. Run: bash scripts/verify.sh"
        )


def browser_check_count():
    return counted("browser-checks.txt", "the browser harness")


def expected_test_count():
    return counted("test-count.txt", "the unit suite")


if __name__ == "__main__":
    sys.exit(main())
