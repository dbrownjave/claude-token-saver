#!/usr/bin/env python3
"""PreCompact: inject keep-list so compaction preserves the expensive bits.

Does not block compaction. Plain additionalContext only.
"""
from __future__ import annotations

import json
import sys

KEEP = (
    "When compacting, keep: current task, files touched, decisions, failing tests, "
    "next steps, exact error messages. Drop: raw tool output, resolved errors, "
    "exploratory file reads, repeated logs."
)


def main() -> int:
    try:
        json.load(sys.stdin)
    except Exception:
        pass
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreCompact",
                "additionalContext": KEEP,
            }
        },
        sys.stdout,
        separators=(",", ":"),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
