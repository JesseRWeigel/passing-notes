#!/usr/bin/env python3
"""Prove the independent checker is actually independent, by reading it rather than trusting it.

A checker that quietly imports the thing it checks, or shells out to node to ask the page for
the answer, will agree with a bug instead of finding it. Grepping for "import" does not settle
it, because `importlib.import_module`, `subprocess.run(["node", ...])` and `exec(open(...))`
all get past a grep and all destroy independence.

So this parses the file and requires three things:

  1. Every import resolves to the standard library.
  2. No call that could reach outside the process: subprocess, os.system, os.popen, exec,
     eval, compile, __import__, importlib.import_module, or ctypes.
  3. No string literal naming this project's own source, so it cannot be reading src/ or
     docs/ as data either.

verify.sh then runs the checker again in a copy of the tree with src/ and docs/ deleted,
which is the part no static reading can fake.

    python3 scripts/check_isolation.py scripts/check_independent.py src docs
"""
from __future__ import annotations

import ast
import os
import sys

BANNED_CALLS = {
    "system", "popen", "exec", "eval", "compile", "__import__",
    "import_module", "run", "Popen", "check_output", "call",
}
BANNED_MODULES = {"subprocess", "importlib", "ctypes", "socket", "urllib", "http", "requests"}


def main(entry: str, *forbidden_dirs: str) -> int:
    problems = []
    with open(entry, encoding="utf-8") as fh:
        source = fh.read()
    tree = ast.parse(source, filename=entry)

    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                problems.append("it uses a relative import, so it is part of a package here")
            elif node.module:
                imported.add(node.module.split(".")[0])

    for name in sorted(imported):
        if name in BANNED_MODULES:
            problems.append(f"it imports {name}, which can reach outside the process")
        elif name not in sys.stdlib_module_names:
            problems.append(f"it imports {name}, which is not part of the standard library")

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            label = getattr(node.func, "attr", None) or getattr(node.func, "id", None)
            if label in BANNED_CALLS:
                problems.append(f"it calls {label}(), which could hand the work to something else")

    # Docstrings are prose about the file and are exempt. Every other string literal is data
    # the program could act on.
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            body = getattr(node, "body", [])
            if body and isinstance(body[0], ast.Expr) and isinstance(body[0].value, ast.Constant):
                docstrings.add(id(body[0].value))

    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and id(node) not in docstrings:
            text = node.value
            for needle in ("src/", "docs/", "node_modules", ".mjs", ".js"):
                if needle in text:
                    problems.append(f"a string literal mentions {needle!r}: {text[:60]!r}")

    for directory in forbidden_dirs:
        if not os.path.isdir(directory):
            problems.append(f"{directory}/ does not exist, so nothing was ever forbidden")

    print(
        f"        {os.path.basename(entry)}: {len(imported)} imports, all standard library "
        f"({', '.join(sorted(imported))}), no call that could reach "
        f"{', '.join(d + '/' for d in forbidden_dirs)}"
    )
    for problem in problems:
        print(f"        {problem}")
    return 1 if problems else 0


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], *sys.argv[2:]))
