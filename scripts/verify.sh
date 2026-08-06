#!/usr/bin/env bash
# Verify passing-notes. The exit code of this script IS the result.
#
# Ordered cheapest first, so a broken tree fails in seconds rather than minutes. Nothing is ever
# skipped: when a dependency is missing this exits nonzero and says what to install, because a
# skipped check reports the same success as one that ran.
#
# Run it from anywhere, including a fresh clone:
#     git clone <this repo> /tmp/pn && cd /tmp/pn && npm install && bash scripts/verify.sh

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

fails=0
stage() { printf '\n== %s\n' "$1"; }
check() {
  local label="$1"
  shift
  if "$@" >/tmp/pn-verify-out 2>&1; then
    printf '  ok    %s\n' "$label"
    sed 's/^/       /' /tmp/pn-verify-out | grep -v '^\s*$' | head -20
  else
    printf '  FAIL  %s\n' "$label"
    sed 's/^/       /' /tmp/pn-verify-out | tail -25
    fails=$((fails + 1))
  fi
}

printf 'passing-notes verify\n'
printf 'node %s\n' "$(node --version 2>/dev/null || echo MISSING)"
printf 'python %s\n' "$(python3 --version 2>&1 || echo MISSING)"

# ---------------------------------------------------------------- 0. the tools exist
stage "toolchain"
for tool in node python3 git; do
  if command -v "$tool" >/dev/null 2>&1; then
    printf '  ok    %s is on PATH\n' "$tool"
  else
    printf '  FAIL  %s is not installed and every stage below needs it\n' "$tool"
    fails=$((fails + 1))
  fi
done
if [ ! -d node_modules/playwright-core ]; then
  printf '  FAIL  playwright-core is missing. Run: npm install && npx playwright install chromium\n'
  printf '        Without a browser the page is never loaded, so the offline claim, the two-player\n'
  printf '        handover and both UI sabotages go unchecked. That is not a partial pass.\n'
  fails=$((fails + 1))
else
  printf '  ok    playwright-core is installed\n'
fi
[ "$fails" -gt 0 ] && { printf '\nRESULT: FAIL (%d)\n' "$fails"; exit 1; }

# ---------------------------------------------------------------- 1. repo hygiene
stage "repo hygiene"
check "no tracked file is larger than a megabyte" python3 - <<'PY'
import subprocess, os, sys
big = []
for f in subprocess.run(["git","ls-files"],capture_output=True,text=True).stdout.split("\n"):
    if f and os.path.exists(f) and os.path.getsize(f) > 1_000_000:
        big.append((f, os.path.getsize(f)))
for f, n in big:
    print(f"{f} is {n} bytes")
print(f"checked {len(subprocess.run(['git','ls-files'],capture_output=True,text=True).stdout.split())} tracked files")
sys.exit(1 if big else 0)
PY

# A NUL byte makes git and grep treat a file as binary, and the secret scan below then skips it
# entirely while reporting the same "clean" as a file it actually read.
check "no tracked file contains a NUL byte, which would blind the scan below" python3 - <<'PY'
import subprocess, os, sys
bad = []
for f in subprocess.run(["git","ls-files"],capture_output=True,text=True).stdout.split("\n"):
    if f and os.path.isfile(f):
        with open(f,"rb") as fh:
            if b"\x00" in fh.read():
                bad.append(f)
for f in bad:
    print(f"{f} contains a NUL byte; write it as the escape \\0 instead")
print(f"{len(bad)} files with a NUL byte")
sys.exit(1 if bad else 0)
PY

check "no credential-shaped strings and no absolute home paths in tracked files" python3 - <<'PY'
import re, subprocess, sys, os
# Case sensitive where the real format is: AWS key ids are uppercase by definition, and a
# case-insensitive version matches ordinary base64 inside any embedded image.
PATTERNS = [
    ("AWS access key id", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("GitHub token", re.compile(rb"gh[pousr]_[A-Za-z0-9]{36}")),
    ("OpenAI style key", re.compile(rb"sk-[A-Za-z0-9]{32,}")),
    ("OpenRouter key", re.compile(rb"sk-or-v1-[a-f0-9]{64}")),
    ("Slack token", re.compile(rb"xox[baprs]-[A-Za-z0-9-]{10,}")),
    ("private key block", re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----")),
    ("an absolute home path", re.compile(rb"/home/[a-z][a-z0-9_-]*/")),
    ("a Windows user path", re.compile(rb"C:\\\\Users\\\\")),
]
hits = []
files = [f for f in subprocess.run(["git","ls-files"],capture_output=True,text=True).stdout.split("\n") if f and os.path.isfile(f)]
for f in files:
    with open(f,"rb") as fh:
        blob = fh.read()
    for label, pattern in PATTERNS:
        for m in pattern.finditer(blob):
            hits.append(f"{f}: {label}: {m.group(0)[:60]!r}")
for h in hits:
    print(h)
print(f"scanned {len(files)} tracked files for {len(PATTERNS)} patterns")
sys.exit(1 if hits else 0)
PY

# ---------------------------------------------------------------- 2. the page matches the source
stage "build"
check "docs/index.html is exactly what src/ produces" node scripts/build.mjs --check

# ---------------------------------------------------------------- 3. unit tests
stage "unit tests"
mkdir -p results
if node --test test/*.test.mjs >/tmp/pn-tests 2>&1; then
  count=$(grep -E '^. tests [0-9]+' /tmp/pn-tests | grep -oE '[0-9]+' | head -1)
  printf '  ok    %s unit tests passed\n' "$count"
  printf '%s\n' "$count" > results/test-count.txt
else
  printf '  FAIL  the unit suite\n'
  tail -30 /tmp/pn-tests | sed 's/^/       /'
  fails=$((fails + 1))
  printf '0\n' > results/test-count.txt
fi

# ---------------------------------------------------------------- 4. three independent replays
stage "the recorded game, replayed three ways"
check "src/ replays fixtures/recorded-game.json" node scripts/check_fixture.mjs

check "the independent checker imports nothing from this package (proved with ast)" \
  python3 scripts/check_isolation.py scripts/check_independent.py src docs

# Static reading cannot prove the checker never touches src/. Deleting src/ and docs/ can.
check "the independent checker still works with src/ and docs/ deleted" bash -c '
  set -e
  work=$(mktemp -d)
  trap "rm -rf $work" EXIT
  cp -r scripts fixtures "$work"/
  rm -rf "$work"/scripts/build.mjs
  cd "$work"
  [ ! -d src ] || { echo "src/ should not have been copied"; exit 1; }
  [ ! -d docs ] || { echo "docs/ should not have been copied"; exit 1; }
  python3 scripts/check_independent.py fixtures/recorded-game.json
  echo "ran with no src/, no docs/, no node_modules"
'

# ---------------------------------------------------------------- 5. measurements
stage "measurement"
check "link length, measured over thousands of games" node scripts/measure.mjs
check "the URL claims, attacked" node scripts/attack_url.mjs

# ---------------------------------------------------------------- 6. the real browser
stage "two real browsers"
if node scripts/browser_play.mjs >/tmp/pn-browser 2>&1; then
  passed=$(grep -oE 'browser checks: [0-9]+' /tmp/pn-browser | grep -oE '[0-9]+' | head -1)
  printf '  ok    %s browser checks passed\n' "$passed"
  sed 's/^/       /' /tmp/pn-browser | tail -8
  printf '%s\n' "$passed" > results/browser-checks.txt
else
  printf '  FAIL  the browser harness\n'
  tail -30 /tmp/pn-browser | sed 's/^/       /'
  fails=$((fails + 1))
  printf '0\n' > results/browser-checks.txt
fi

# ---------------------------------------------------------------- 7. do the checks catch anything
stage "sabotage: three gates and a null control"
if [ "${PN_SKIP_SABOTAGE:-}" = "1" ]; then
  printf '  FAIL  PN_SKIP_SABOTAGE is set. The sabotage stage is what shows the checks above can\n'
  printf '        fail at all, so skipping it makes this run "could not verify", not "verified".\n'
  fails=$((fails + 1))
else
  if python3 scripts/sabotage.py --json results/sabotage.json >/tmp/pn-sabotage 2>&1; then
    printf '  ok    %s\n' "$(grep -E 'sabotages applied' /tmp/pn-sabotage | sed 's/^ *//')"
    grep -E 'NULL CONTROL|GUARD CONTROL|^    ok|^    FAIL' /tmp/pn-sabotage | sed 's/^/       /'
  else
    printf '  FAIL  the sabotage stage\n'
    grep -E 'FAIL|refusing|GATE' /tmp/pn-sabotage | sed 's/^/       /' | head -25
    fails=$((fails + 1))
  fi
fi

# ---------------------------------------------------------------- 8. the README is part of the deliverable
stage "the README"
check "the README says what this is, rather than carrying the scaffold" bash -c '
  set -e
  for phrase in "TODO" "NOT YET VERIFIED" "replace with a real description"; do
    if grep -qF "$phrase" README.md; then
      echo "README.md still contains the scaffold text: $phrase"
      exit 1
    fi
  done
  grep -q "^## Status" README.md || { echo "README.md has no Status section"; exit 1; }
  grep -q "bash scripts/verify.sh" README.md || { echo "README.md never names the verify command"; exit 1; }
  grep -q "^## What does not hold" README.md || { echo "README.md must state what does not hold"; exit 1; }
  echo "README.md has a description, a Status section, the verify command and an honesty section"
'

check "every number in the README matches something that was measured" python3 scripts/check_claims.py

# The Status section has to carry this run'"'"'s own success line, otherwise the code can be green
# while the README still describes a project that was never run.
check "the Status section carries the success line this script prints" bash -c '
  set -e
  grep -qF "RESULT: PASS" README.md || {
    echo "README.md Status section does not contain the RESULT: PASS line this script prints"
    exit 1
  }
  echo "the Status section quotes a real passing run"
'

# ---------------------------------------------------------------- the verdict
printf '\n'
if [ "$fails" -eq 0 ]; then
  printf 'RESULT: PASS\n'
  exit 0
fi
printf 'RESULT: FAIL (%d stage(s))\n' "$fails"
exit 1
