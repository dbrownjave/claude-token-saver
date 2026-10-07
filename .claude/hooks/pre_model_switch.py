#!/usr/bin/env python3
"""PreModelSwitch: warn when a mid-session switch would bust a warm cache.

Ask only when the cache is warm and context is large. Fail-open to allow.
"""
from __future__ import annotations

import json
import sys

ASK_AFTER_TOKENS = 20000


def main() -> int:
    try:
        data = json.load(sys.stdin)
    except Exception:
        return 0

    warm = bool(data.get("prompt_cache_warm"))
    tokens = int(data.get("context_tokens") or 0)
    source = data.get("source") or ""
    to_model = data.get("to_model") or data.get("requested_model") or "unknown"
    cost = data.get("estimated_cache_write_usd")

    # Auto / resume switches are harness-driven; don't fight them.
    if source in {"auto", "resume"}:
        return 0
    if not warm or tokens < ASK_AFTER_TOKENS:
        return 0

    reason = (
        f"Switching model mid-session re-sends ~{tokens} tokens"
        + (f" (~${cost:.2f} cache write)" if isinstance(cost, (int, float)) else "")
        + f" to {to_model} and can miss the warm prompt cache. "
        "Prefer /clear and a new session, or confirm if this switch is required."
    )
    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreModelSwitch",
                "permissionDecision": "ask",
                "permissionDecisionReason": reason,
            }
        },
        sys.stdout,
        separators=(",", ":"),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
