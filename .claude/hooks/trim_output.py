#!/usr/bin/env python3
"""PostToolUse: trim huge successful Bash stdout. Fail-open.

Never trim failures (stderr / interrupted). Keep head + tail so errors survive.
If the harness ignores updatedToolOutput, this is still a no-op rather than a crash.
"""
from __future__ import annotations

import json
import sys

KEEP_HEAD = 60
KEEP_TAIL = 20
LIMIT = 4000


def trim(text: str) -> str:
    lines = text.splitlines()
    if len(text) < LIMIT:
        return text
    if len(lines) <= KEEP_HEAD + KEEP_TAIL + 5:
        return text
    dropped = len(lines) - KEEP_HEAD - KEEP_TAIL
    head = lines[:KEEP_HEAD]
    tail = lines[-KEEP_TAIL:]
    meta = (
        f"... trimmed {dropped} lines / {len(text)} chars. "
        "Failures are in head+tail. Re-run with a narrower command if you need the rest."
    )
    return "\n".join(head + [meta] + tail)


def main() -> int:
    try:
        data = json.load(sys.stdin)
        resp = data.get("tool_response") or data.get("tool_result") or {}
        if not isinstance(resp, dict):
            return 0
        stdout = resp.get("stdout")
        stderr = resp.get("stderr") or ""
        interrupted = bool(resp.get("interrupted"))
        if not isinstance(stdout, str) or interrupted or str(stderr).strip():
            return 0
        new = trim(stdout)
        if new == stdout:
            return 0
        updated = {
            "stdout": new,
            "stderr": stderr,
            "interrupted": False,
            "isImage": bool(resp.get("isImage")),
        }
        json.dump(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PostToolUse",
                    "updatedToolOutput": updated,
                }
            },
            sys.stdout,
            separators=(",", ":"),
        )
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
