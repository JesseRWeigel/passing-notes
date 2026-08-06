#!/usr/bin/env python3
"""Break the code on purpose and find out whether anything notices.

A test suite that has never been shown to fail is a suite nobody has tested. This file takes a
clean copy of the tree, introduces one specific defect, and requires the checks to catch it.

THE THREE GATE RULE
-------------------
Every sabotage has to clear three gates in order, and the harness reports a failure if it stops
at any of them. The gates exist because the honest-looking conclusion "the checks have a gap" is
usually wrong, and is usually caused by an attack that did nothing:

  GATE 1  APPLIED.  The pattern was found exactly once, the replacement differs, and the bytes on
                    disk changed. scripts/patch.py enforces this and the harness re-hashes the
                    file afterwards rather than taking its word.

  GATE 2  CHANGED.  The MEASURED OUTPUT moved. Not the file, the behaviour. A fingerprint of what
                    the code computes is taken before and after, and if it is identical then the
                    sabotage touched a line nothing depends on. Such a sabotage proves nothing
                    about the checks and is reported as a FAILURE OF THE SABOTAGE, never as a
                    passing check and never as a gap.

  GATE 3  CAUGHT.   Only now does the verdict mean anything. At least one guard must exit
                    nonzero, and the harness records which ones did.

THE NULL CONTROL
----------------
Before any sabotage runs, the tree is copied UNCHANGED into a second directory and fingerprinted
there. That fingerprint must be byte for byte identical to the baseline.

This is not a formality. If the fingerprint picks up anything about where it is running, a
temporary path, a timestamp, a random seed, an mtime, then gate 2 passes automatically for every
sabotage and the whole harness silently validates attacks that proved nothing. The control is the
only thing standing between this file and a confident write-up of eleven meaningless results.
If the control fails, everything below it is refused rather than reported.

WHAT THE FINGERPRINTS COVER
---------------------------
  node  scripts/fingerprint.mjs, which imports src/courier.mjs, src/reversi.mjs and src/rtc.mjs
        and dumps what they compute. Fast, and blind to the page.
  page  scripts/fingerprint_page.mjs, which loads docs/index.html in a real browser and dumps
        what the page does. Slower, and the only thing that can see src/ui.mjs.

A sabotage declares which one it expects to move. Declaring the wrong one shows up as a gate 2
failure, which is the correct outcome: the harness must not choose a measurement that happens to
notice.

    python3 scripts/sabotage.py            every sabotage
    python3 scripts/sabotage.py --list     just show them
    python3 scripts/sabotage.py --only 3   one of them, by number
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Copied into every working tree. node_modules is symlinked instead, results/ is derived output
# that the harness has no reason to carry, and .git would make each copy enormous.
COPY_IGNORE = shutil.ignore_patterns(".git", "node_modules", "results", "__pycache__", "*.pyc")

# The guards, by the name a sabotage refers to. Each is a command and the thing it is for.
GUARDS = {
    "build": (["node", "scripts/build.mjs", "--check"], "docs/index.html still matches src/"),
    # Node 24 resolves a bare directory as a module rather than expanding it, so `--test test/`
    # exits nonzero on a perfectly healthy tree. That made this guard "catch" every sabotage
    # including ones it could not see. The files are listed explicitly, and check_guards below
    # is what stops the same class of mistake returning.
    "tests": (["node", "--test", "__TESTFILES__"], "the unit suite"),
    "fixture": (["node", "scripts/check_fixture.mjs"], "src/ replays the recorded game"),
    "independent": (
        ["python3", "scripts/check_independent.py", "fixtures/recorded-game.json"],
        "the clean-room Python replay",
    ),
    "isolation": (
        ["python3", "scripts/check_isolation.py", "scripts/check_independent.py", "src", "docs"],
        "the independent checker is still independent",
    ),
    "browser": (["node", "scripts/browser_play.mjs"], "two real browsers play a whole game"),
}

# Every guard that is not specific to one sabotage. Used to report collateral catches.
DEFAULT_CATCHERS = ["tests", "fixture", "independent"]

SABOTAGES = [
    {
        "name": "move ordering reversed",
        "why": "legalMoves order IS the wire format, so reversing it silently redefines every code",
        "file": "src/reversi.mjs",
        "old": "out.push(cell);",
        "new": "out.unshift(cell);",
        "fingerprint": "node",
    },
    {
        "name": "one of the eight directions dropped",
        "why": "discs stop flipping up-left, which changes the rules without changing the API",
        "file": "src/reversi.mjs",
        "old": "const DIRS = [-9, -8, -7, -1, 1, 7, 8, 9];",
        "new": "const DIRS = [-8, -7, -1, 1, 7, 8, 9];",
        "fingerprint": "node",
    },
    {
        "name": "row-edge wrap guard disabled",
        "why": "a run of discs can wrap around the side of the board, the classic Reversi bug",
        "file": "src/reversi.mjs",
        "old": "if (step === -1 || step === 7 || step === -9) return toCol === fromCol - 1;",
        "new": "if (step === -1 || step === 7 || step === -9) return true;",
        "fingerprint": "node",
    },
    {
        "name": "opening position corrupted",
        "why": "every game starts somewhere else, so every existing code decodes differently",
        "file": "src/reversi.mjs",
        "old": "cells[27] = WHITE;",
        "new": "cells[27] = BLACK;",
        "fingerprint": "node",
    },
    {
        "name": "a bracketed run no longer needs a bracket",
        "why": "flipsFor accepts a run that runs off the board instead of ending on your own disc",
        "file": "src/reversi.mjs",
        "old": "if (cells[next] === colour && run.length > 0) break;",
        "new": "if (run.length > 0) break;",
        "fingerprint": "node",
    },
    {
        "name": "the canonical-form check removed",
        "why": "this is the defect this project actually shipped with; it must not come back",
        "file": "src/courier.mjs",
        "old": "if (a !== 1n) {",
        "new": "if (false) {",
        "fingerprint": "node",
    },
    {
        "name": "CRC polynomial altered",
        "why": "the checksum still exists and still runs, and no longer agrees with the spec",
        "file": "src/courier.mjs",
        "old": "crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;",
        "new": "crc = crc & 0x8000 ? ((crc << 1) ^ 0x1022) & 0xffff : (crc << 1) & 0xffff;",
        "fingerprint": "node",
    },
    {
        "name": "base64 spare-bit check removed",
        "why": "several distinct codes then decode to the same bytes, so corruption becomes an alias",
        "file": "src/courier.mjs",
        "old": "if ((last & spare) !== 0) {",
        "new": "if (false) {",
        "fingerprint": "node",
    },
    {
        "name": "forced moves no longer derived",
        "why": "the zero-bit saving is the whole point of the encoding; without it codes get longer",
        "file": "src/courier.mjs",
        "old": "} else if (legal.length === 1) {",
        "new": "} else if (false) {",
        "fingerprint": "node",
    },
    {
        "name": "the proven length bound halved",
        "why": "the bound is a promise about the worst case, and a wrong one is worse than none",
        "file": "src/courier.mjs",
        "old": "const bits = Math.ceil(log2Product) + 1;",
        "new": "const bits = Math.ceil(log2Product / 2) + 1;",
        "fingerprint": "node",
    },
    {
        "name": "mixed-radix accumulation off by one",
        "why": "encode and decode stop being inverses, which a round-trip test has to notice",
        "file": "src/courier.mjs",
        "old": "acc = acc * BigInt(radix) + BigInt(index);",
        "new": "acc = acc * BigInt(radix) + BigInt(index) + 1n;",
        "fingerprint": "node",
    },
    {
        "name": "the page lies about being serverless",
        "why": "rtcHonesty exists to stop exactly this, and its failure mode is a quiet false claim",
        "file": "src/rtc.mjs",
        "old": "    serverless: false,",
        "new": "    serverless: true,",
        "fingerprint": "node",
    },
    {
        "name": "the rewind guard disabled",
        "why": "an opponent can then replay an older link to undo a losing move and nothing objects",
        "file": "src/ui.mjs",
        "old": "if (!force && known && !next.extendsFrom(known)) {",
        "new": "if (false && known && !next.extendsFrom(known)) {",
        "fingerprint": "page",
        "catchers": ["browser"],
    },
    {
        # The one that justifies scripts/check_independent.py existing at all. Every other
        # sabotage here is caught by a JavaScript check reading a fixture recorded from
        # JavaScript. Re-record the fixture from the sabotaged code and those two agree with
        # each other perfectly, both wrong. Only an implementation that shares nothing with
        # them can still object.
        "name": "move order reversed AND the fixture re-recorded to match",
        "why": "two derivations that agree can both be wrong; only the clean room can see it",
        "file": "src/reversi.mjs",
        "old": "out.push(cell);",
        "new": "out.unshift(cell);",
        "fingerprint": "node",
        "prepare": [["node", "scripts/browser_play.mjs", "--record"]],
        "catchers": ["fixture", "independent"],
        "expect": ["independent"],
    },
    {
        "name": "the score readout swapped",
        "why": "a display-only bug that no module test can see, because no module renders anything",
        "file": "src/ui.mjs",
        "old": "el('score-black').textContent = String(score.black);",
        "new": "el('score-black').textContent = String(score.white);",
        "fingerprint": "page",
        "catchers": ["browser"],
    },
]


def run(command, cwd):
    """Exit code and combined output, with no shell in the way."""
    resolved = []
    for word in command:
        if word == "__TESTFILES__":
            found = sorted(
                os.path.join("test", n) for n in os.listdir(os.path.join(cwd, "test"))
                if n.endswith(".test.mjs")
            )
            if not found:
                raise SystemExit("there are no test files, so the tests guard cannot mean anything")
            resolved.extend(found)
        else:
            resolved.append(word)
    done = subprocess.run(
        resolved, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True
    )
    return done.returncode, done.stdout


def check_guards(tree, names):
    """Every guard must PASS on unsabotaged code before it is allowed to condemn anything.

    A guard that fails on a clean tree reports "caught" for every sabotage, including the ones it
    cannot see, and the harness then certifies attacks that proved nothing. That is not
    hypothetical: `node --test test/` exits nonzero on a healthy tree under Node 24, because a
    bare directory is resolved as a module. It sat in this file marking every sabotage caught.

    This is the gate-3 counterpart of the null control, and it exists for the same reason.
    """
    problems = []
    for name in names:
        command, purpose = GUARDS[name]
        code, output = run(command, tree)
        if code == 0:
            print(f"    ok    {name:12} exits 0 on clean code, so a nonzero exit means something")
        else:
            problems.append(name)
            print(f"    FAIL  {name:12} exits {code} on CLEAN code, so it cannot distinguish anything")
            for line in output.strip().splitlines()[-4:]:
                print(f"          {line[:110]}")
    return problems


def stage(destination):
    """A clean copy of the tree, with node_modules borrowed rather than duplicated."""
    shutil.copytree(ROOT, destination, ignore=COPY_IGNORE, symlinks=True)
    modules = os.path.join(ROOT, "node_modules")
    if os.path.isdir(modules):
        os.symlink(modules, os.path.join(destination, "node_modules"))
    return destination


def fingerprint(tree, which):
    """What the code computes, as a string. Never raises: a crash IS a fingerprint."""
    script = "scripts/fingerprint.mjs" if which == "node" else "scripts/fingerprint_page.mjs"
    code, output = run(["node", script], tree)
    return f"exit={code}\n{output}"


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def file_hash(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--list", action="store_true", help="show the sabotages and stop")
    parser.add_argument("--only", type=int, help="run one sabotage, by its number")
    parser.add_argument("--json", help="write the full result to this path")
    args = parser.parse_args()

    if args.list:
        for i, sab in enumerate(SABOTAGES, 1):
            print(f"  {i:2}. {sab['name']}  ({sab['file']}, {sab['fingerprint']} fingerprint)")
        return 0

    chosen = SABOTAGES if args.only is None else [SABOTAGES[args.only - 1]]
    needs_page = any(s["fingerprint"] == "page" for s in chosen)

    problems = []
    results = []

    with tempfile.TemporaryDirectory(prefix="passing-notes-sabotage-") as workspace:
        # ---------------------------------------------------------- baseline
        print("  building a clean baseline")
        baseline_tree = stage(os.path.join(workspace, "baseline"))
        code, output = run(["node", "scripts/build.mjs"], baseline_tree)
        if code != 0:
            print(f"    the clean tree does not even build, so nothing below is meaningful\n{output}")
            return 1

        baseline = {"node": fingerprint(baseline_tree, "node")}
        if needs_page:
            baseline["page"] = fingerprint(baseline_tree, "page")
        for which, text in baseline.items():
            print(f"    baseline {which:5} fingerprint {digest(text)}  ({len(text)} bytes)")
            if "NO BROWSER" in text or "BROWSER WILL NOT START" in text:
                print("    the page fingerprint needs a browser and there is not one.")
                print("    Install it with: npm install && npx playwright install chromium")
                return 1

        # ---------------------------------------------------------- the null control
        print("\n  NULL CONTROL: an unchanged copy of the tree must fingerprint identically")
        control_tree = stage(os.path.join(workspace, "null-control"))
        run(["node", "scripts/build.mjs"], control_tree)
        control_ok = True
        for which, want in baseline.items():
            got = fingerprint(control_tree, which)
            if got == want:
                print(f"    ok    {which:5} {digest(got)} matches, so the measurement is of the code")
            else:
                control_ok = False
                print(f"    FAIL  {which:5} {digest(got)} != {digest(want)}")
                print("          The fingerprint depends on something other than the code, most")
                print("          likely a path, a timestamp or a random seed. Gate 2 would then")
                print("          pass for every sabotage and prove nothing.")
                for a, b in zip(want.splitlines(), got.splitlines()):
                    if a != b:
                        print(f"          baseline: {a[:100]}")
                        print(f"          control : {b[:100]}")
                        break
        if not control_ok:
            print("\n  refusing to run any sabotage while the null control fails")
            return 1

        # ---------------------------------------------------------- the guards must work
        used = sorted({g for s in chosen for g in s.get("catchers", DEFAULT_CATCHERS)})
        print("\n  GUARD CONTROL: every guard must exit 0 on the clean baseline")
        broken = check_guards(baseline_tree, used)
        if broken:
            print(f"\n  refusing to run: {', '.join(broken)} cannot tell clean code from sabotaged code")
            return 1

        # ---------------------------------------------------------- the sabotages
        for number, sab in enumerate(chosen, 1 if args.only is None else args.only):
            print(f"\n  {number}. {sab['name']}")
            print(f"     {sab['file']}: {sab['why']}")
            tree = stage(os.path.join(workspace, f"sabotage-{number}"))
            run(["node", "scripts/build.mjs"], tree)
            target = os.path.join(tree, sab["file"])
            record = {"number": number, "name": sab["name"], "file": sab["file"]}

            # ---- GATE 1: it applied and the bytes moved
            before = file_hash(target)
            code, output = run(
                ["python3", "scripts/patch.py", sab["file"], sab["old"], sab["new"]], tree
            )
            after = file_hash(target) if os.path.exists(target) else before
            if code != 0 or before == after:
                print(f"     GATE 1 FAIL  the sabotage did not apply. {output.strip()}")
                problems.append(f"{number}. {sab['name']}: did not apply")
                record.update(gate1=False, gate2=None, gate3=None)
                results.append(record)
                continue
            print(f"     gate 1 ok    applied, {sab['file']} changed on disk")
            record["gate1"] = True

            # The page is rebuilt from the sabotaged sources, so that build --check cannot be
            # the thing that catches every src/ edit for free. An attacker would run the build.
            run(["node", "scripts/build.mjs"], tree)

            # ---- GATE 2: the measured behaviour moved
            which = sab["fingerprint"]
            got = fingerprint(tree, which)
            if got == baseline[which]:
                print(f"     GATE 2 FAIL  the {which} fingerprint is unchanged ({digest(got)}).")
                print("                  This sabotage edited a line nothing depends on. It proves")
                print("                  nothing about the checks, so it is a failure of the")
                print("                  sabotage and NOT a gap in the verification.")
                problems.append(f"{number}. {sab['name']}: applied but changed no measured behaviour")
                record.update(gate2=False, gate3=None)
                results.append(record)
                continue
            changed_lines = sum(
                1
                for a, b in zip(baseline[which].splitlines(), got.splitlines())
                if a != b
            )
            print(f"     gate 2 ok    the {which} fingerprint moved {digest(baseline[which])} -> {digest(got)} ({changed_lines} lines differ)")
            record.update(gate2=True, fingerprintWas=digest(baseline[which]), fingerprintNow=digest(got))

            # Some sabotages need the attacker to do more than edit a file, for example to
            # re-record the fixture so the JavaScript checks agree with the new behaviour.
            for step in sab.get("prepare", []):
                step_code, step_output = run(step, tree)
                label = " ".join(step[1:])
                print(f"       prep  {label} -> exit {step_code}")
                if step_code != 0:
                    print(f"              {step_output.strip().splitlines()[-1][:100] if step_output.strip() else ''}")

            # ---- GATE 3: something caught it
            catchers = sab.get("catchers", DEFAULT_CATCHERS)
            caught_by = []
            for guard in catchers:
                command, purpose = GUARDS[guard]
                guard_code, _ = run(command, tree)
                mark = "caught" if guard_code != 0 else "     "
                print(f"       {mark:7} {guard:12} {purpose}")
                if guard_code != 0:
                    caught_by.append(guard)
            record["caughtBy"] = caught_by
            # Where a sabotage exists to justify one particular check, that check is the one
            # that has to fire. "Something else noticed" would leave the point unproven.
            missing = [g for g in sab.get("expect", []) if g not in caught_by]
            if missing:
                print(f"     GATE 3 FAIL  {', '.join(missing)} had to catch this one and did not")
                problems.append(f"{number}. {sab['name']}: {', '.join(missing)} did not catch it")
                record["gate3"] = False
            elif caught_by:
                print(f"     gate 3 ok    caught by {', '.join(caught_by)}")
                record["gate3"] = True
            else:
                print(f"     GATE 3 FAIL  the behaviour changed and NOTHING caught it")
                problems.append(f"{number}. {sab['name']}: changed behaviour, caught by nothing")
                record["gate3"] = False
            results.append(record)

    print("\n  " + "-" * 68)
    passed = sum(1 for r in results if r.get("gate3"))
    print(f"  {passed} of {len(results)} sabotages applied, changed the measured output, and were caught")
    for problem in problems:
        print(f"  FAILED  {problem}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as handle:
            json.dump(
                {"sabotages": results, "problems": problems, "nullControl": "passed"},
                handle,
                indent=2,
            )
            handle.write("\n")

    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
