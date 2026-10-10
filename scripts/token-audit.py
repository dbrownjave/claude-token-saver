#!/usr/bin/env python3
"""Measure startup context the team can run in a terminal or CI.

Usage:
  python3 scripts/token-audit.py
  python3 scripts/token-audit.py --json
  python3 scripts/token-audit.py --fail-on 2000
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def find_root(start: Path) -> Path:
    cur = start.resolve()
    for p in [cur, *cur.parents]:
        if (p / "CLAUDE.md").exists() or (p / ".claude").is_dir():
            return p
    return cur


def bytes_of(path: Path) -> int:
    try:
        return path.stat().st_size if path.is_file() else 0
    except OSError:
        return 0


def dir_md(path: Path) -> tuple[int, int]:
    if not path.is_dir():
        return 0, 0
    total = 0
    n = 0
    for f in path.rglob("*"):
        if f.is_file() and f.suffix.lower() in {".md", ".json"}:
            total += bytes_of(f)
            n += 1
    return total, n


def approx_tokens(n: int) -> int:
    return max(0, n // 4)


def collect(root: Path) -> dict:
    claude_md = bytes_of(root / "CLAUDE.md") + bytes_of(root / ".claude" / "CLAUDE.md")
    rules_b, rules_n = dir_md(root / ".claude" / "rules")
    skills_b, skills_n = dir_md(root / ".claude" / "skills")
    hooks_b, hooks_n = dir_md(root / ".claude" / "hooks")
    settings_b = bytes_of(root / ".claude" / "settings.json")
    mcp_path = root / ".mcp.json"
    if not mcp_path.is_file():
        mcp_path = root / ".claude" / ".mcp.json"
    mcp_b = bytes_of(mcp_path)
    mcp_servers = 0
    if mcp_path.is_file():
        try:
            mcp_servers = len((json.loads(mcp_path.read_text(encoding="utf-8")).get("mcpServers") or {}))
        except Exception:
            mcp_servers = -1

    startup = claude_md + rules_b + settings_b + mcp_b
    return {
        "root": str(root),
        "claude_md_bytes": claude_md,
        "claude_md_tokens": approx_tokens(claude_md),
        "rules_bytes": rules_b,
        "rules_files": rules_n,
        "rules_tokens": approx_tokens(rules_b),
        "skills_bytes": skills_b,
        "skills_files": skills_n,
        "hooks_files": hooks_n,
        "settings_bytes": settings_b,
        "mcp_bytes": mcp_b,
        "mcp_servers": mcp_servers,
        "startup_tokens_est": approx_tokens(startup),
        "warnings": [],
    }


def warn(report: dict) -> list[str]:
    w = []
    if report["claude_md_tokens"] > 1000:
        w.append(
            f"CLAUDE.md is ~{report['claude_md_tokens']} tokens. Target <500–1000. Move workflows into skills."
        )
    if report["mcp_servers"] and report["mcp_servers"] > 3:
        w.append(
            f"{report['mcp_servers']} MCP servers configured. Each schema loads every turn. Disable unused in /mcp."
        )
    if report["rules_tokens"] > 2000:
        w.append(f"Rules total ~{report['rules_tokens']} tokens. Split with paths: so unused rules stay cold.")
    return w


def render(report: dict) -> str:
    lines = [
        f"Token audit  {report['root']}",
        f"  CLAUDE.md     ~{report['claude_md_tokens']:>5} tokens  ({report['claude_md_bytes']} bytes)",
        f"  rules         ~{report['rules_tokens']:>5} tokens  ({report['rules_files']} files)",
        f"  skills        ~{approx_tokens(report['skills_bytes']):>5} tokens  ({report['skills_files']} files, loaded on demand)",
        f"  settings.json ~{approx_tokens(report['settings_bytes']):>5} tokens",
        f"  mcp.json      ~{approx_tokens(report['mcp_bytes']):>5} tokens  ({report['mcp_servers']} servers)",
        f"  startup est   ~{report['startup_tokens_est']:>5} tokens  (CLAUDE.md + rules + settings + mcp)",
        "",
        "Not counted here: system prompt, bundled tools, MCP schemas once connected, conversation history.",
        "In a session run /context for the live breakdown.",
    ]
    if report["warnings"]:
        lines.append("")
        lines.extend("  WARN  " + x for x in report["warnings"])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Audit Claude Code startup context")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--fail-on", type=int, default=0, help="Exit 1 if CLAUDE.md tokens exceed this")
    args = parser.parse_args()

    report = collect(find_root(Path.cwd()))
    report["warnings"] = warn(report)

    if args.json:
        json.dump(report, sys.stdout, indent=2)
        sys.stdout.write("\n")
    else:
        sys.stdout.write(render(report))

    if args.fail_on and report["claude_md_tokens"] > args.fail_on:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
