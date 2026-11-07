#!/usr/bin/env python3
"""What a session of this project costs before you type: measured from its transcripts, then split by source.

Measured: the first assistant turn of each recent session under ~/.claude/projects/<this project> records
input + cache write + cache read. That sum is the startup. Attributed: what reached the model in that turn, read from
the transcript's own record of it (CLAUDE.md files, rules, memory, skill listing, agent listing, tool names) or, where
the transcript has none, from the files on disk. The remainder is the part of the system prompt the transcript does not
record plus the built-in tool definitions.

Usage:
  python3 scripts/token-audit.py
  python3 scripts/token-audit.py --sessions 20
  python3 scripts/token-audit.py --json
  python3 scripts/token-audit.py --fail-on 2000     exit 1 if CLAUDE.md files exceed this many tokens
  python3 scripts/token-audit.py --no-api           never call the token-count API, even with a key set

With ANTHROPIC_API_KEY set the per-source figures come from the token-count API (free, rate limited; it sees the same
text every session already sends). Without one they are bytes/4 estimates and marked with ~.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import urllib.request
from pathlib import Path

# What decides a subagent's prompt-cache TTL, strongest first. Every subagent request gets the 5-minute cache unless
# one of these says 1h; a 1h cache write costs 2× base input against 1.25× for 5m, so it pays only for agents that idle
# past 5 minutes mid-run. The mod (/tokens) measures those lapses; this audit shows what is set.
TTL_ENV_FORCE = "FORCE_PROMPT_CACHING_5M"
TTL_ENV = "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"
TTL_SETTING = "subagentPromptCacheTtl"
TTL_INFO_ENV = "ENABLE_PROMPT_CACHING_1H"

MEMORY_LINES = 200  # Claude Code loads the first 200 lines of MEMORY.md

# Sources in display order. "disk" says whether the files on disk can predict it for the next session.
SOURCES = [
    ("claude_md_user", "user CLAUDE.md + imports", True),
    ("claude_md_project", "project CLAUDE.md + imports", True),
    ("rules_user", "user rules", True),
    ("rules_project", "project rules", True),
    ("memory", "auto-memory MEMORY.md", True),
    ("skills", "skill listing", True),
    ("agents", "agent listing", True),
    ("mcp_tools", "MCP and connector tool names", False),
    ("mcp_instructions", "MCP server instructions", False),
    ("deferred_builtin", "deferred built-in tool names", False),
    ("system_prompt", "system prompt (recorded part)", False),
    ("first_message", "first message, hooks, session context", False),
]
REMAINDER_LABEL = "rest of system prompt and built-in tools"


def find_root(start: Path) -> Path:
    cur = start.resolve()
    for p in [cur, *cur.parents]:
        if (p / "CLAUDE.md").exists() or (p / ".claude").is_dir():
            return p
    return cur


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
    except OSError:
        return ""


def read_json(path: Path) -> dict:
    try:
        v = json.loads(path.read_text(encoding="utf-8"))
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def approx_tokens(text: str) -> int:
    return len(text.encode("utf-8")) // 4


def frontmatter(text: str) -> str:
    m = re.match(r"\A---\r?\n(.*?)\r?\n---(?:\r?\n|\Z)", text, re.S)
    return m.group(1) if m else ""


def body_of(text: str) -> str:
    m = re.match(r"\A---\r?\n.*?\r?\n---(?:\r?\n|\Z)", text, re.S)
    return text[m.end():] if m else text


def fm_field(fm: str, key: str) -> str:
    """One top-level frontmatter field, plain, quoted or as a | / > block; no PyYAML."""
    lines = fm.splitlines()
    for i, line in enumerate(lines):
        m = re.match(rf"^{re.escape(key)}:\s*(.*)$", line)
        if not m:
            continue
        v = m.group(1).strip()
        if v[:1] in ("|", ">"):
            block = []
            for child in lines[i + 1:]:
                if child.strip() and not child.startswith((" ", "\t")):
                    break
                block.append(child.strip())
            return " ".join(x for x in block if x)
        return v.strip("\"'")
    return ""


# ---------------------------------------------------------------- measured: first turn of each session

def sanitize(path: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(path))


def main_root(root: Path) -> Path:
    """The checkout a worktree belongs to: transcripts and auto-memory are keyed by it."""
    try:
        out = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], cwd=root,
                             capture_output=True, text=True, timeout=5, check=False).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        out = ""
    if out and Path(out).name == ".git":
        return Path(out).parent.resolve()
    return root


def project_dirs(root: Path) -> list[Path]:
    base = config_dir() / "projects"
    if not base.is_dir():
        return []
    keys = {sanitize(root), sanitize(main_root(root))}
    return sorted(d for d in base.iterdir() if d.is_dir() and any(d.name == k or d.name.startswith(k + "--claude-worktrees-") for k in keys))


def text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def sent_from(pre: list[dict]) -> dict[str, str]:
    """What the transcript records as sent before the first reply, grouped into SOURCES keys."""
    parts: dict[str, list[str]] = {}

    def add(key: str, text) -> None:
        if text:
            parts.setdefault(key, []).append(text if isinstance(text, str) else "\n".join(map(str, text)))

    for o in pre:
        if o.get("type") == "user" and not o.get("isSidechain"):
            add("first_message", text_of((o.get("message") or {}).get("content")))
        a = o.get("attachment")
        if not isinstance(a, dict):
            continue
        t = a.get("type")
        if t == "instructions":
            for f in a.get("files") or []:
                path, kind = str(f.get("path", "")), f.get("type")
                if kind == "AutoMem":
                    key = "memory"
                elif "/.claude/rules/" in path or path.startswith(str(config_dir() / "rules") + os.sep):
                    key = "rules_user" if kind == "User" else "rules_project"
                else:
                    key = "claude_md_user" if kind == "User" else "claude_md_project"
                add(key, f.get("content", ""))
        elif t == "skill_listing":
            add("skills", a.get("content", ""))
        elif t == "agent_listing_delta":
            add("agents", a.get("addedLines") or [])
        elif t == "deferred_tools_delta":
            names = a.get("addedLines") or a.get("addedNames") or []
            add("mcp_tools", [n for n in names if str(n).startswith("mcp__")])
            add("deferred_builtin", [n for n in names if not str(n).startswith("mcp__")])
        elif t == "mcp_instructions_delta":
            add("mcp_instructions", a.get("addedBlocks") or [])
        elif t == "prompt_snapshot":
            add("system_prompt", [p for p in a.get("systemPrompt") or [] if "DYNAMIC_BOUNDARY" not in p])
        elif t == "hook_success":
            add("first_message", a.get("content", ""))
        elif t == "session_context":
            add("first_message", list((a.get("context") or {}).values()))
        elif t in ("model", "total_tokens_reminder"):
            add("first_message", a.get("text", ""))
    return {k: "\n".join(v) for k, v in parts.items()}


def first_turn(path: Path) -> dict | None:
    pre: list[dict] = []
    try:
        fh = path.open(encoding="utf-8", errors="replace")
    except OSError:
        return None
    with fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if not isinstance(o, dict):
                continue
            msg = o.get("message") if isinstance(o.get("message"), dict) else {}
            if o.get("type") == "assistant" and not o.get("isSidechain"):
                u = msg.get("usage") or {}
                total = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
                if msg.get("model") == "<synthetic>" or not total:
                    continue
                return {
                    "session": path.stem, "path": str(path), "timestamp": o.get("timestamp") or "",
                    "model": msg.get("model") or "", "version": o.get("version") or "",
                    "input": int(u.get("input_tokens") or 0),
                    "cache_write": int(u.get("cache_creation_input_tokens") or 0),
                    "cache_read": int(u.get("cache_read_input_tokens") or 0),
                    "total": total, "sent": sent_from(pre),
                }
            pre.append(o)
    return None


def measured(root: Path, n: int) -> list[dict]:
    turns = [t for d in project_dirs(root) for f in d.glob("*.jsonl") if (t := first_turn(f))]
    turns.sort(key=lambda t: t["timestamp"])
    return turns[-n:] if n > 0 else turns


# ---------------------------------------------------------------- on disk: what the next session will load

IMPORT_RE = re.compile(r"(?:^|\s)@((?:~/|/|\./|\.\./)?[\w.~/-]+)")


def with_imports(path: Path, seen: set[Path], depth: int = 0) -> list[Path]:
    """A CLAUDE.md and every file its @imports pull in, each once. Imports inside code are not skipped."""
    try:
        real = path.resolve()
    except OSError:
        return []
    if real in seen or not real.is_file() or depth > 5:
        return []
    seen.add(real)
    out = [real]
    text = re.sub(r"```.*?```", "", read_text(real), flags=re.S)
    for m in IMPORT_RE.finditer(text):
        target = Path(os.path.expanduser(m.group(1)))
        if not target.is_absolute():
            target = real.parent / target
        out += with_imports(target, seen, depth + 1)
    return out


def rule_files(folder: Path) -> list[Path]:
    """Rules that load at startup. A rule with paths: in its frontmatter loads only when a matching file is read."""
    if not folder.is_dir():
        return []
    return sorted(p.resolve() for p in folder.rglob("*.md") if not fm_field(frontmatter(read_text(p)), "paths"))


def enabled_plugins(root: Path) -> list[tuple[str, Path]]:
    """(prefix, folder) of every plugin the next session loads: installed ones set true in enabledPlugins, and synced
    ones unless set false. Project settings override user settings."""
    enabled: dict = {}
    for p in (config_dir() / "settings.json", root / ".claude" / "settings.json", root / ".claude" / "settings.local.json"):
        ep = read_json(p).get("enabledPlugins")
        if isinstance(ep, dict):
            enabled.update(ep)
    out: list[tuple[str, Path]] = []
    installed = read_json(config_dir() / "plugins" / "installed_plugins.json")
    for key, entries in (installed.get("plugins", installed) or {}).items():
        if enabled.get(key) is not True or not isinstance(entries, (list, dict)):
            continue
        entry = entries[0] if isinstance(entries, list) and entries else entries
        if isinstance(entry, dict) and entry.get("installPath"):
            out.append((key.split("@")[0], Path(entry["installPath"])))
    seen = {name for name, _ in out}
    synced = config_dir() / "plugins" / "synced"
    for d in sorted(synced.glob("*/*")) if synced.is_dir() else []:
        name = d.name.split("~")[0]
        if d.is_dir() and not d.name.startswith(".") and name not in seen and enabled.get(f"{name}@synced", True) is not False:
            seen.add(name)
            out.append((name, d))
    return out


def listing_line(path: Path, prefix: str, fallback: str, command: bool = False) -> str:
    text = read_text(path)
    fm = frontmatter(text)
    if fm_field(fm, "disable-model-invocation").lower() == "true":
        return ""
    name = fm_field(fm, "name") or fallback
    desc = fm_field(fm, "description")
    if not desc and command:
        desc = next((x.strip() for x in body_of(text).splitlines() if x.strip()), "")
    return f"- {prefix + ':' if prefix else ''}{name}: {desc}\n"


def skill_listing(root: Path, plugins: list[tuple[str, Path]]) -> tuple[str, int]:
    lines: list[str] = []
    places = [("", config_dir() / "skills"), ("", root / ".claude" / "skills")] + [(n, p / "skills") for n, p in plugins]
    for prefix, folder in places:
        for f in sorted(folder.glob("*/SKILL.md")) if folder.is_dir() else []:
            lines.append(listing_line(f, prefix, f.parent.name))
    synced = config_dir() / "skills" / "synced"
    for f in sorted(synced.glob("*/*/SKILL.md")) if synced.is_dir() else []:
        lines.append(listing_line(f, "anthropic-skills", f.parent.name))
    cmds = [("", config_dir() / "commands"), ("", root / ".claude" / "commands")] + [(n, p / "commands") for n, p in plugins]
    for prefix, folder in cmds:
        for f in sorted(folder.rglob("*.md")) if folder.is_dir() else []:
            lines.append(listing_line(f, prefix, f.stem, command=True))
    lines = [x for x in lines if x]
    return "".join(lines), len(lines)


def agent_listing(root: Path, plugins: list[tuple[str, Path]]) -> tuple[str, int]:
    lines = []
    places = [("", config_dir() / "agents"), ("", root / ".claude" / "agents")] + [(n, p / "agents") for n, p in plugins]
    for prefix, folder in places:
        for f in sorted(folder.glob("*.md")) if folder.is_dir() else []:
            lines.append(listing_line(f, prefix, f.stem))
    return "".join(lines), len(lines)


def on_disk(root: Path) -> tuple[dict[str, str], dict[str, list[Path]], dict]:
    """Text per source key, the files behind the instruction sources, and counts for the detail line."""
    seen: set[Path] = set()
    user_md = config_dir() / "CLAUDE.md"
    files: dict[str, list[Path]] = {"claude_md_user": with_imports(user_md, seen), "claude_md_project": []}
    for d in [root, *root.parents]:
        for name in ("CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"):
            if (d / name).resolve() != user_md.resolve():
                files["claude_md_project"] += with_imports(d / name, seen)
    files["rules_user"] = rule_files(config_dir() / "rules")
    files["rules_project"] = rule_files(root / ".claude" / "rules")
    mem = config_dir() / "projects" / sanitize(main_root(root)) / "memory" / "MEMORY.md"
    files["memory"] = [mem] if mem.is_file() else []
    text = {k: "\n".join(read_text(p) for p in v) for k, v in files.items()}
    if text["memory"]:
        text["memory"] = "\n".join(text["memory"].splitlines()[:MEMORY_LINES])
    plugins = enabled_plugins(root)
    text["skills"], n_skills = skill_listing(root, plugins)
    text["agents"], n_agents = agent_listing(root, plugins)
    return text, files, {"skills": n_skills, "agents": n_agents, "plugins": [n for n, _ in plugins]}


def duplicates(files: dict[str, list[Path]]) -> list[dict]:
    """Instruction files that load the same text twice: one file reached two ways, or two files sharing most lines."""
    flat = [(k, p) for k, ps in files.items() for p in ps]
    out, seen = [], set()
    for i, (ka, a) in enumerate(flat):
        for kb, b in flat[i + 1:]:
            pair = tuple(sorted((str(a), str(b))))
            if pair in seen:
                continue
            seen.add(pair)
            if a == b:
                out.append({"a": str(a), "b": str(b), "shared": read_text(a), "why": "the same file loads twice"})
                continue
            la = {x.strip() for x in read_text(a).splitlines() if len(x.strip()) > 8}
            lb = [x.strip() for x in read_text(b).splitlines() if len(x.strip()) > 8]
            shared = [x for x in lb if x in la]
            small = min(len(la), len(set(lb))) or 1
            if len(set(shared)) / small >= 0.5:
                out.append({"a": str(a), "b": str(b), "shared": "\n".join(shared),
                            "why": "same name, shared lines" if a.name == b.name else "shared lines"})
    return out


# ---------------------------------------------------------------- counting

def count_with_api(texts: dict[str, str], model: str) -> dict[str, int] | None:
    """Exact tokens per text from /v1/messages/count_tokens, minus the message frame. None on any failure."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key:
        return None
    url = (os.environ.get("ANTHROPIC_BASE_URL") or "https://api.anthropic.com").rstrip("/") + "/v1/messages/count_tokens"

    def one(text: str) -> int:
        body = json.dumps({"model": model, "messages": [{"role": "user", "content": text}]}).encode()
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            return int(json.loads(r.read())["input_tokens"])

    try:
        frame = one(".") - 1
        return {k: max(0, one(v) - frame) if v else 0 for k, v in texts.items()}
    except Exception:
        return None


# ---------------------------------------------------------------- agents and their cache (unchanged)

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
            fm = frontmatter(read_text(f))
            name = re.search(r"^name:\s*(.+)$", fm, re.M)
            out.append({"scope": scope, "name": (name.group(1).strip() if name else f.stem), "path": str(f), "cacheTtl": cache_ttl_of(fm)})
    return out


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


# ---------------------------------------------------------------- report

def collect(root: Path, sessions: int = 10, use_api: bool = True) -> dict:
    turns = measured(root, sessions)
    latest = turns[-1] if turns else None
    disk_text, files, counts = on_disk(root)
    sent = (latest or {}).get("sent") or {}

    # The latest session's own record wins; a source it does not record falls back to disk.
    latest_text = {k: sent.get(k, disk_text.get(k, "")) if latest else disk_text.get(k, "") for k, _, _ in SOURCES}
    dups = duplicates(files)
    model = (latest or {}).get("model") or "claude-sonnet-5-5"
    to_count = {**{f"latest.{k}": v for k, v in latest_text.items()},
                **{f"now.{k}": v for k, v in disk_text.items()},
                **{f"dup.{i}": d["shared"] for i, d in enumerate(dups)}}
    counted = count_with_api(to_count, model) if use_api else None
    tok = counted or {k: approx_tokens(v) for k, v in to_count.items()}

    rows = []
    for key, label, disk_ok in SOURCES:
        rows.append({
            "key": key, "label": label,
            "latest": tok[f"latest.{key}"],
            "latest_from": ("transcript" if key in sent else "disk") if latest else "disk",
            "now": tok.get(f"now.{key}") if disk_ok else None,
        })
    attributed = sum(r["latest"] for r in rows)
    entries = lambda t: sum(1 for x in t.splitlines() if x.startswith("- "))
    counts["skills_sent"], counts["agents_sent"] = entries(latest_text["skills"]), entries(latest_text["agents"])
    totals = [t["total"] for t in turns]
    report = {
        "root": str(root),
        "counting": "api" if counted else "estimate",
        "measured": {
            "sessions": [{k: t[k] for k in ("session", "timestamp", "model", "version", "input", "cache_write", "cache_read", "total")} for t in turns],
            "latest": latest["total"] if latest else None,
            "median": int(statistics.median(totals)) if totals else None,
            "change": (totals[-1] - totals[0]) if len(totals) > 1 else None,
        },
        "sources": rows,
        "attributed": attributed,
        "remainder": (latest["total"] - attributed) if latest else None,
        "remainder_label": REMAINDER_LABEL,
        "counts": counts,
        "duplicates": [{"a": d["a"], "b": d["b"], "why": d["why"], "tokens": tok[f"dup.{i}"]} for i, d in enumerate(dups)],
        "not_sent": ["settings.json", "skill and agent bodies (only name + description is listed)", "hook scripts"],
        "agents": agent_files(root),
        "warnings": [],
    }
    # Kept for --fail-on and the warnings below; figures for the next session.
    report["claude_md_tokens"] = (tok["now.claude_md_user"] or 0) + (tok["now.claude_md_project"] or 0)
    report["rules_tokens"] = (tok["now.rules_user"] or 0) + (tok["now.rules_project"] or 0)
    mcp = read_json(root / ".mcp.json") or read_json(root / ".claude" / ".mcp.json")
    report["mcp_servers"] = len(mcp.get("mcpServers") or {})
    srcs = ttl_sources(root)
    report["ttl_sources"] = srcs
    report["ttl_override"] = srcs[0] if srcs else None
    report["ttl_1h_env"] = os.environ.get(TTL_INFO_ENV) or None
    return report


def warn(report: dict) -> list[str]:
    w = []
    if report["claude_md_tokens"] > 1000:
        w.append(f"CLAUDE.md files are {report['claude_md_tokens']} tokens. Target <500–1000. Move workflows into skills.")
    if report["mcp_servers"] and report["mcp_servers"] > 3:
        w.append(f"{report['mcp_servers']} MCP servers configured. Each one's tool names load every session. Disable unused in /mcp.")
    if report["rules_tokens"] > 2000:
        w.append(f"Rules total {report['rules_tokens']} tokens. Split with paths: so unused rules stay cold.")
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


def num(n: int | None, est: bool = False) -> str:
    if n is None:
        return "—"
    return f"{'~' if est else ''}{n:,}"


def short(n: int) -> str:
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def home(p: str) -> str:
    h = str(Path.home())
    return "~" + p[len(h):] if p.startswith(h + os.sep) else p


def rel(p: str, root: str) -> str:
    return p[len(root) + 1:] if p.startswith(root + os.sep) else home(p)


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
    m = report["measured"]
    sessions = m["sessions"]
    est = report["counting"] == "estimate"
    lines = [f"Startup tokens  {home(report['root'])}"]
    if sessions:
        last = sessions[-1]
        ch = m["change"]
        lines += [
            f"  latest   {m['latest']:>8,}  measured  {last['timestamp'][:10]}  {last['model']}",
            f"  median   {m['median']:>8,}  measured  last {len(sessions)} session{'s' if len(sessions) != 1 else ''}",
            f"  change   {'—' if ch is None else f'{ch:+,}':>8}  measured  since {sessions[0]['timestamp'][:10]}",
            "",
            "  trend    " + " ".join(short(s["total"]) for s in sessions) + "   (oldest → newest)",
        ]
    else:
        lines.append("  no session transcripts for this project yet; the figures below are what the files on disk would load")
    how = "counted with the token-count API" if not est else "~ = estimate (bytes/4); set ANTHROPIC_API_KEY for counted tokens"
    lines += ["", f"Where the latest startup went  ({how})", f"  {'':<40}{'latest':>9}{'on disk now':>13}"]
    c = report["counts"]
    for r in report["sources"]:
        if not r["latest"] and not r["now"]:
            continue
        label = r["label"]
        if r["key"] in ("skills", "agents"):
            label += f": {c[r['key'] + '_sent']} sent, {c[r['key']]} on disk"
        mark = "" if r["latest_from"] == "transcript" or not sessions else "*"
        lines.append(f"  {label:<40}{num(r['latest'], est) + mark:>9}{num(r['now'], est):>13}")
    if report["remainder"] is not None:
        lines.append(f"  {REMAINDER_LABEL:<40}{num(report['remainder'], est):>9}   measured minus the lines above")
    if sessions and any(r["latest_from"] == "disk" and r["latest"] for r in report["sources"]):
        lines.append("  * not recorded in the latest transcript; taken from the files on disk")
    lines.append("  Not sent at startup, so not counted: " + ", ".join(report["not_sent"]) + ".")
    if report["duplicates"]:
        lines += ["", "Loaded twice"]
        for d in report["duplicates"]:
            a, b = rel(d["a"], report["root"]), rel(d["b"], report["root"])
            lines.append(f"  {a} and {b}: {d['why']}, {num(d['tokens'], est)} tokens sent twice. Keep one.")
    lines.extend(render_agents(report))
    if report["warnings"]:
        lines.append("")
        lines.extend("  WARN  " + x for x in report["warnings"])
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure and attribute Claude Code startup tokens")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--sessions", type=int, default=10, help="How many recent sessions to measure (default 10)")
    parser.add_argument("--no-api", action="store_true", help="Never call the token-count API")
    parser.add_argument("--fail-on", type=int, default=0, help="Exit 1 if CLAUDE.md tokens exceed this")
    args = parser.parse_args()

    report = collect(find_root(Path.cwd()), args.sessions, use_api=not args.no_api)
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
