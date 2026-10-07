#!/usr/bin/env python3
"""SessionStart auditor. Prints a short budget line to Claude context.

Keep this output tiny. SessionStart stdout is injected into context.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

MAX_CONTEXT_CHARS = 700
WARN_CLAUDE_MD = 4000  # ~1k tokens
WARN_RULES = 8000
WARN_SETTINGS = 6000


def count_chars(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


def collect(root: Path) -> dict:
    claude_md = root / "CLAUDE.md"
    settings = root / ".claude" / "settings.json"
    rules_dir = root / ".claude" / "rules"
    skills_dir = root / ".claude" / "skills"
    mcp = root / ".mcp.json"

    rules = 0
    rule_files = 0
    if rules_dir.is_dir():
        for p in rules_dir.rglob("*.md"):
            rules += count_chars(p)
            rule_files += 1

    skills = 0
    skill_files = 0
    if skills_dir.is_dir():
        for p in skills_dir.rglob("SKILL.md"):
            skills += count_chars(p)
            skill_files += 1

    mcp_servers = 0
    if mcp.is_file():
        try:
            data = json.loads(mcp.read_text(encoding="utf-8"))
            mcp_servers = len(data.get("mcpServers") or {})
        except Exception:
            mcp_servers = -1

    return {
        "claude_md": count_chars(claude_md),
        "settings": count_chars(settings),
        "rules": rules,
        "rule_files": rule_files,
        "skills": skills,
        "skill_files": skill_files,
        "mcp_servers": mcp_servers,
    }


def tok(n: int) -> int:
    return max(0, n // 4)


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
    source = "startup"
    cache_expired = None
    try:
        payload = json.loads(raw) if raw.strip() else {}
        source = payload.get("source") or source
        cache_expired = payload.get("prompt_cache_likely_expired")
    except Exception:
        payload = {}

    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
    stats = collect(root)
    warns = []
    if stats["claude_md"] > WARN_CLAUDE_MD:
        warns.append(f"CLAUDE.md ~{tok(stats['claude_md'])} tok (trim under 1k)")
    if stats["rules"] > WARN_RULES:
        warns.append(f"rules ~{tok(stats['rules'])} tok")
    if stats["mcp_servers"] and stats["mcp_servers"] > 3:
        warns.append(f"{stats['mcp_servers']} MCP servers load every turn — disable unused in /mcp")

    lines = [
        "Token budget active. One task per session. /clear on topic change.",
        (
            f"startup {source}: CLAUDE.md ~{tok(stats['claude_md'])} tok, "
            f"rules {stats['rule_files']} files ~{tok(stats['rules'])} tok, "
            f"skills {stats['skill_files']} ~{tok(stats['skills'])} tok"
            + (f", mcp {stats['mcp_servers']}" if stats["mcp_servers"] else "")
            + "."
        ),
    ]
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
