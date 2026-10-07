#!/usr/bin/env python3
"""PreToolUse: rewrite known-noisy Bash commands using quiet.json.

Fail-open. Never exit 2. First matching enabled rule wins.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

HOOK_DIR = Path(__file__).resolve().parent
PACK_DIR = HOOK_DIR.parent  # ~/.claude/token-saver or pack/.claude


def map_candidates() -> list[Path]:
    home = Path.home() / ".claude" / "token-saver" / "quiet.json"
    proj = os.environ.get("CLAUDE_PROJECT_DIR")
    out = [home]
    if proj:
        out.append(Path(proj) / ".claude" / "token-saver" / "quiet.json")
    out.append(PACK_DIR / "quiet.json")
    # pack layout when running from the zip, not the installed copy
    out.append(HOOK_DIR.parent.parent / "quiet.json")
    return out


def load_map() -> dict:
    for path in map_candidates():
        if path.is_file():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                data["_path"] = str(path)
                return data
            except Exception:
                continue
    return {"rewrites": [], "skip_if_contains": ["&&", "||", "|", ";"], "danger": []}


def ledger_path() -> Path:
    return Path.home() / ".claude" / "token-saver" / "ledger.jsonl"


def log_rewrite(rule_id: str, before: str, after: str) -> None:
    try:
        path = ledger_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        rec = {
            "ts": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "id": rule_id,
            "before": before[:300],
            "after": after[:300],
            "chars_in": len(before),
            "chars_out": len(after),
        }
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, separators=(",", ":")) + "\n")
    except Exception:
        pass


def quiet(cmd: str, cfg: dict | None = None) -> tuple[str, str] | None:
    """Return (new_cmd, rule_id) or None."""
    cfg = cfg or load_map()
    s = cmd.strip()
    if not s:
        return None
    for token in cfg.get("skip_if_contains") or ["&&", "||", "|", ";"]:
        if token in s:
            return None
    for pat in cfg.get("danger") or []:
        try:
            if re.search(pat, s):
                return None
        except re.error:
            if pat in s:
                return None
    for rule in cfg.get("rewrites") or []:
        if rule.get("enabled") is False:
            continue
        pattern = rule.get("pattern") or ""
        if not pattern:
            continue
        try:
            if not re.search(pattern, s):
                continue
        except re.error:
            continue
        unless = rule.get("unless") or []
        if any(u in s for u in unless):
            continue
        if rule.get("replace"):
            new = rule["replace"]
        elif rule.get("append"):
            new = s + rule["append"]
        else:
            continue
        if new == s:
            return None
        return new, str(rule.get("id") or "custom")
    return None


def main() -> int:
    try:
        data = json.load(sys.stdin)
        inp = data.get("tool_input") or {}
        cmd = inp.get("command")
        if not isinstance(cmd, str):
            return 0
        hit = quiet(cmd)
        if not hit:
            return 0
        new, rule_id = hit
        log_rewrite(rule_id, cmd, new)
        out = dict(inp)
        out["command"] = new
        json.dump(
            {"hookSpecificOutput": {"hookEventName": "PreToolUse", "updatedInput": out}},
            sys.stdout,
            separators=(",", ":"),
        )
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
