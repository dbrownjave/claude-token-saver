#!/usr/bin/env python3
"""Claude Code statusline: cache warm/cold + context fill.

Reads the official session JSON from stdin. One line to stdout.
Docs: prompt_cache.warm, ttl, expires_at, hit_ratio, recache_tokens_if_cold.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path


def fmt_n(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.1f}M"
    if n >= 1_000:
        return f"{n/1_000:.0f}k"
    return str(n)


def load_levels() -> list:
    path = Path.home() / ".claude" / "token-saver" / "thresholds.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        levels = data.get("levels") or []
        return [lv for lv in levels if isinstance(lv, dict) and lv.get("pct") is not None]
    except Exception:
        return [
            {"id": "watch", "pct": 40, "hint": "note"},
            {"id": "handoff", "pct": 60, "hint": "new-conversation"},
            {"id": "compact", "pct": 75, "hint": "compact-if-warm"},
        ]


def hint_for(pct: float, warm: bool) -> str:
    hit = None
    for lv in load_levels():
        if pct >= float(lv["pct"]) and (hit is None or float(lv["pct"]) > float(hit["pct"])):
            hit = lv
    if not hit:
        return ""
    kind = str(hit.get("hint") or "note")
    mark = f"{hit.get('id') or 'limit'} {int(hit['pct'])}%"
    if kind == "new-conversation":
        return f"{mark} handoff"
    if kind == "compact-if-warm":
        return f"{mark} compact" if warm else f"{mark} new chat"
    return mark


def main() -> int:
    raw = sys.stdin.read()
    try:
        data = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError:
        sys.stdout.write("cache —")
        return 0

    cache = data.get("prompt_cache") if isinstance(data.get("prompt_cache"), dict) else None
    ctx = data.get("context_window") if isinstance(data.get("context_window"), dict) else {}
    model = ""
    m = data.get("model")
    if isinstance(m, dict):
        model = str(m.get("display_name") or "")[:12]

    used = ctx.get("used_percentage")
    ctx_s = f"ctx {int(used)}%" if isinstance(used, (int, float)) else ""

    if not cache:
        mark = hint_for(float(used), False) if isinstance(used, (int, float)) else ""
        parts = [p for p in (model, "cache —", ctx_s, mark) if p]
        sys.stdout.write("  ".join(parts))
        return 0

    warm = bool(cache.get("warm"))
    ttl = str(cache.get("ttl") or "")
    ratio = cache.get("hit_ratio")
    recache = int(cache.get("recache_tokens_if_cold") or 0)
    expires = cache.get("expires_at")
    left = ""
    if isinstance(expires, (int, float)) and expires > 0:
        secs = int(expires - time.time())
        cap = 3600 if ttl == "1h" else 300
        if 0 < secs <= cap + 5:
            left = f"{secs // 60}m" if secs >= 60 else f"{secs}s"

    if warm:
        hit = f"{ratio*100:.0f}%" if isinstance(ratio, (int, float)) else ""
        bits = ["● cache"]
        if hit:
            bits.append(hit)
        if ttl:
            bits.append(ttl)
        if left:
            bits.append(left)
        line = " ".join(bits)
    else:
        extra = f"+{fmt_n(recache)} if you type" if recache else "type = full re-cache"
        line = f"▲ COLD  {extra}"

    mark = hint_for(float(used), warm) if isinstance(used, (int, float)) else ""
    parts = [p for p in (model, line, ctx_s, mark) if p]
    sys.stdout.write("  ".join(parts))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
