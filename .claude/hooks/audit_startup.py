#!/usr/bin/env python3
"""SessionStart auditor. Prints a short budget line to Claude context.

Keep this output tiny. SessionStart stdout is injected into context.

The startup figure is measured, never estimated: scripts/token-audit.py reads the first assistant turn of this
project's recent transcripts (input + cache write + cache read). No token-count API call happens here.
"""
from __future__ import annotations

import importlib.util
import json
import os
import statistics
import sys
from pathlib import Path

MAX_CONTEXT_CHARS = 700
SESSIONS = 10
MAX_DUPLICATES = 2
WARN_CLAUDE_MD = 4000  # bytes
WARN_RULES = 8000
WARN_SETTINGS = 6000


def count_chars(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def collect(root: Path) -> dict:
    """File sizes for the warnings. Sizes in bytes, never turned into tokens."""
    rules_dir = root / ".claude" / "rules"
    mcp = root / ".mcp.json"

    rules = sum(count_chars(p) for p in rules_dir.rglob("*.md")) if rules_dir.is_dir() else 0

    mcp_servers = 0
    if mcp.is_file():
        try:
            data = json.loads(mcp.read_text(encoding="utf-8"))
            mcp_servers = len(data.get("mcpServers") or {})
        except Exception:
            mcp_servers = -1

    return {
        "claude_md": count_chars(root / "CLAUDE.md"),
        "rules": rules,
        "mcp_servers": mcp_servers,
    }


def kb(n: int) -> str:
    return f"{n / 1024:.1f} KB"


def load_audit():
    """scripts/token-audit.py as a module, from the installed layout or the pack repo. None if missing or broken."""
    here = Path(__file__).resolve().parent
    candidates = [
        here.parent / "scripts" / "token-audit.py",         # installed: ~/.claude/token-saver/{hooks,scripts}
        here.parent.parent / "scripts" / "token-audit.py",  # in the pack repo: .claude/hooks -> scripts
    ]
    script = next((c for c in candidates if c.is_file()), None)
    if not script:
        return None
    try:
        spec = importlib.util.spec_from_file_location("token_audit", script)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod
    except Exception:
        return None


def startup_lines(root: Path, audit) -> list[str]:
    """Measured startup of the last session and the median, plus rules that load twice. Never fails the hook."""
    if audit is None:
        return []
    out = []
    try:
        totals = [t["total"] for t in audit.measured(root, SESSIONS)]
    except Exception:
        totals = []
    if totals:
        line = f"Startup (measured): last session {totals[-1]:,} tokens"
        if len(totals) > 1:
            line += f", median {int(statistics.median(totals)):,} over {len(totals)} sessions"
        out.append(line + ".")
    try:
        _, files, _ = audit.on_disk(root)
        dups = audit.duplicates(files)
    except Exception:
        dups = []
    if dups:
        here = str(root)
        pairs = [f"{audit.rel(d['a'], here)} + {audit.rel(d['b'], here)}" for d in dups[:MAX_DUPLICATES]]
        more = f" (+{len(dups) - MAX_DUPLICATES} more)" if len(dups) > MAX_DUPLICATES else ""
        out.append("Loaded twice: " + "; ".join(pairs) + more + ". Keep one copy.")
    return out


def skills_hint(root: Path) -> str:
    """One line naming parked skills that fit this repo, or nothing. Never fails the hook."""
    here = Path(__file__).resolve().parent
    candidates = [
        here.parent / "scripts" / "skills.py",                       # installed: ~/.claude/token-saver/{hooks,scripts}
        here.parent.parent / "plugins" / "token-saver" / "scripts" / "skills.py",  # in the pack repo
    ]
    script = next((c for c in candidates if c.is_file()), None)
    if not script:
        return ""
    try:
        import subprocess
        res = subprocess.run(
            [sys.executable, str(script), "suggest", "--brief", "--project", str(root)],
            capture_output=True, text=True, timeout=4,
        )
    except Exception:
        return ""
    return res.stdout.strip() if res.returncode == 0 else ""


def main() -> int:
    raw = sys.stdin.read()
    cache_expired = None
    try:
        payload = json.loads(raw) if raw.strip() else {}
        cache_expired = payload.get("prompt_cache_likely_expired")
    except Exception:
        payload = {}

    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    stats = collect(root)
    warns = []
    if stats["claude_md"] > WARN_CLAUDE_MD:
        warns.append(f"CLAUDE.md is {kb(stats['claude_md'])} (trim under {kb(WARN_CLAUDE_MD)})")
    if stats["rules"] > WARN_RULES:
        warns.append(f"project rules are {kb(stats['rules'])}")
    if stats["mcp_servers"] and stats["mcp_servers"] > 3:
        warns.append(f"{stats['mcp_servers']} MCP servers load every turn — disable unused in /mcp")

    lines = ["Token budget active. One task per session. /clear on topic change."]
    lines += startup_lines(root, load_audit())
    if cache_expired is True:
        lines.append("Prompt cache likely expired. Prefer /clear over compacting a cold history.")
    if warns:
        lines.append("WARN: " + "; ".join(warns) + ".")
    hint = skills_hint(root)
    if hint:
        lines.append(hint)

    text = "\n".join(lines)
    if len(text) > MAX_CONTEXT_CHARS:
        text = text[: MAX_CONTEXT_CHARS - 3] + "..."

    # Plain stdout is injected as SessionStart context.
    sys.stdout.write(text)
    # Human-readable copy for the debug log only.
    sys.stderr.write(text + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
