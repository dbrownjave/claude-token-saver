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
import os
import re
import sys
from pathlib import Path

# What decides a subagent's prompt-cache TTL, strongest first. Every subagent request gets the 5-minute cache unless
# one of these says 1h; a 1h cache write costs 2× base input against 1.25× for 5m, so it pays only for agents that idle
# past 5 minutes mid-run. The mod (/tokens) measures those lapses; this audit shows what is set.
TTL_ENV_FORCE = "FORCE_PROMPT_CACHING_5M"
TTL_ENV = "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"
TTL_SETTING = "subagentPromptCacheTtl"
TTL_INFO_ENV = "ENABLE_PROMPT_CACHING_1H"


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


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def frontmatter(text: str) -> str:
    m = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.S)
    return m.group(1) if m else ""


def cache_ttl_of(fm: str) -> str | None:
    """`experimental:\n  cacheTtl: 1h` or `experimental: { cacheTtl: 1h }` in an agent file's frontmatter; no PyYAML."""
    inline = re.search(r"^experimental:\s*\{[^}]*\bcacheTtl\s*:\s*[\"']?(\w+)", fm, re.M)
    if inline:
        return inline.group(1)
    lines = fm.splitlines()
    for i, line in enumerate(lines):
        if re.match(r"^experimental:\s*$", line):
            for child in lines[i + 1:]:
                if child.strip() and not child.startswith((" ", "\t")):
                    break
                m = re.match(r"^\s+cacheTtl\s*:\s*[\"']?(\w+)", child)
                if m:
                    return m.group(1)
    return None


def agent_files(root: Path) -> list[dict]:
    """Agent files the person owns: ~/.claude/agents (user) and <root>/.claude/agents (project). Plugin agents are
    not listed: a plugin update overwrites them, so a cacheTtl set there does not last."""
    out: list[dict] = []
    for scope, folder in (("user", config_dir() / "agents"), ("project", root / ".claude" / "agents")):
        if not folder.is_dir():
            continue
        for f in sorted(folder.glob("*.md")):
            try:
                fm = frontmatter(f.read_text(encoding="utf-8", errors="replace"))
            except OSError:
                fm = ""
            name = re.search(r"^name:\s*(.+)$", fm, re.M)
            out.append({"scope": scope, "name": (name.group(1).strip() if name else f.stem), "path": str(f), "cacheTtl": cache_ttl_of(fm)})
    return out


def read_json(path: Path) -> dict:
    try:
        v = json.loads(path.read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def ttl_sources(root: Path) -> list[dict]:
    """Every place a subagent TTL is set, in precedence order: FORCE_PROMPT_CACHING_5M in the live environment, then
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL there, then each settings file's subagentPromptCacheTtl and env block."""
    out: list[dict] = []
    for key in (TTL_ENV_FORCE, TTL_ENV):
        if os.environ.get(key):
            out.append({"source": "environment", "key": key, "value": os.environ[key]})
    files = [
        ("~/.claude/settings.json", config_dir() / "settings.json"),
        ("~/.claude/settings.local.json", config_dir() / "settings.local.json"),
        (".claude/settings.json", root / ".claude" / "settings.json"),
        (".claude/settings.local.json", root / ".claude" / "settings.local.json"),
    ]
    for label, path in files:
        data = read_json(path)
        if not data:
            continue
        env = data.get("env") if isinstance(data.get("env"), dict) else {}
        for key in (TTL_ENV_FORCE, TTL_ENV):
            if env.get(key):
                out.append({"source": label, "key": f"env.{key}", "value": str(env[key])})
        if data.get(TTL_SETTING):
            out.append({"source": label, "key": TTL_SETTING, "value": str(data[TTL_SETTING])})
    return out


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
    agents = agent_files(root)
    sources = ttl_sources(root)
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
        "agents": agents,
        "ttl_sources": sources,
        "ttl_override": sources[0] if sources else None,
        "ttl_1h_env": os.environ.get(TTL_INFO_ENV) or None,
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
    o = report.get("ttl_override")
    if o:
        w.append(f"{o['key']}={o['value']} in {o['source']} sets how long every agent's cache lasts, whatever its own file says.")
    elif report.get("agents") and not any(a["cacheTtl"] for a in report["agents"]):
        n = len(report["agents"])
        w.append(
            f"{n} agent file{'s' if n != 1 else ''} keep{'s' if n == 1 else ''} the default: an agent forgets what it read after 5 minutes of waiting and "
            "re-reads it. Give an agent a 1-hour cache (cacheTtl: 1h under experimental) only if /tokens shows it waiting that long; a 1-hour cache costs more per write."
        )
    return w


def render_agents(report: dict) -> list[str]:
    lines = ["", "Agents: how long each one remembers what it read"]
    agents = report.get("agents") or []
    if agents:
        for a in agents:
            ttl = {"1h": "1 hour", "5m": "5 minutes", None: "5 minutes (default)"}.get(a["cacheTtl"], str(a["cacheTtl"]))
            lines.append(f"  {a['scope']}/{a['name']:<28} {ttl}")
    else:
        lines.append("  no agent files in ~/.claude/agents or .claude/agents")
    o = report.get("ttl_override")
    if o:
        lines.append(f"  override      {o['key']}={o['value']} in {o['source']} sets every agent, whatever its file says")
    else:
        lines.append("  override      none: each agent file decides (subagentPromptCacheTtl, CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL and FORCE_PROMPT_CACHING_5M are unset)")
    if report.get("ttl_1h_env"):
        lines.append(f"  {TTL_INFO_ENV}={report['ttl_1h_env']} in the environment (informational)")
    lines.append("  An agent that waits over 5 minutes on one step (a build, a test run) re-reads everything it had. /tokens shows which agents did.")
    lines.append("  Agents that come with a plugin are not listed: an update overwrites their files. Copy one into ~/.claude/agents to change it.")
    return lines


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
    lines.extend(render_agents(report))
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
