#!/usr/bin/env python3
"""Token-saver terminal dashboard and Claude A/B bench.

Modes:
  dash              free — read ~/.claude/projects transcripts
  bench             local hook bench (no Claude spend)
  bench --live      A/B via `claude -p` (costs tokens; asks first)

Zero required deps. Optional: `rich` if installed.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

PACK = Path(__file__).resolve().parents[1]
HOOKS = PACK / ".claude" / "hooks"
if not HOOKS.is_dir():
    alt = Path.home() / ".claude" / "token-saver" / "hooks"
    if alt.is_dir():
        HOOKS = alt

# Approximate Sonnet-class list prices for the estimate column only.
PRICE = {
    "in": 3.00,
    "out": 15.00,
    "cache_read": 0.30,
    "cache_write": 3.75,
}


class C:
    reset = "\033[0m"
    dim = "\033[2m"
    bold = "\033[1m"
    cyan = "\033[36m"
    green = "\033[32m"
    yellow = "\033[33m"
    red = "\033[31m"
    mag = "\033[35m"
    white = "\033[37m"
    bg = "\033[40m"


def color_ok() -> bool:
    return sys.stdout.isatty() and os.environ.get("NO_COLOR") is None


def paint(text: str, *codes: str) -> str:
    if not color_ok():
        return text
    return "".join(codes) + text + C.reset


def box(title: str, lines: list[str], width: int = 88) -> str:
    title = f" {title} "
    inner = width - 2
    top = "╭" + title + "─" * max(0, inner - len(title)) + "╮"
    out = [paint(top, C.cyan, C.bold)]
    for line in lines:
        raw = _strip(line)
        pad = max(0, inner - _vis(raw))
        out.append(paint("│", C.cyan) + line + " " * pad + paint("│", C.cyan))
    out.append(paint("╰" + "─" * inner + "╯", C.cyan))
    return "\n".join(out)


def _strip(s: str) -> str:
    out = []
    i = 0
    while i < len(s):
        if s[i] == "\033":
            j = s.find("m", i)
            i = j + 1 if j != -1 else i + 1
            continue
        out.append(s[i])
        i += 1
    return "".join(out)


def _vis(s: str) -> int:
    return len(_strip(s))


def bar(frac: float, width: int = 24, fill: str = "█", empty: str = "░") -> str:
    frac = max(0.0, min(1.0, frac))
    n = int(round(frac * width))
    body = fill * n + empty * (width - n)
    if frac > 0.85:
        return paint(body, C.red)
    if frac > 0.55:
        return paint(body, C.yellow)
    return paint(body, C.green)


def fmt_n(n: int) -> str:
    if n >= 1_000_000:
        return f"{n/1_000_000:.2f}M"
    if n >= 1_000:
        return f"{n/1_000:.1f}k"
    return str(n)


def fmt_usd(x: float) -> str:
    return f"${x:,.4f}" if x < 1 else f"${x:,.2f}"


def est_cost(usage: dict) -> float:
    return (
        usage.get("input", 0) * PRICE["in"]
        + usage.get("output", 0) * PRICE["out"]
        + usage.get("cache_read", 0) * PRICE["cache_read"]
        + usage.get("cache_write", 0) * PRICE["cache_write"]
    ) / 1_000_000


def approx_tokens(text: str) -> int:
    return max(0, (len(text) + 3) // 4)


# ── transcripts ──────────────────────────────────────────────


def claude_roots() -> list[Path]:
    roots = []
    cfg = os.environ.get("CLAUDE_CONFIG_DIR")
    if cfg:
        roots.append(Path(cfg).expanduser() / "projects")
    roots.append(Path.home() / ".claude" / "projects")
    extra = Path.home() / ".config" / "claude" / "projects"
    if extra not in roots:
        roots.append(extra)
    return [p for p in roots if p.is_dir()]


def iter_jsonl(root: Path):
    for p in root.rglob("*.jsonl"):
        name = p.name
        if "orphaned" in name or "superseded" in name:
            continue
        yield p


def parse_usage_block(block: dict | None) -> dict:
    if not isinstance(block, dict):
        return {}
    return {
        "input": int(block.get("input_tokens") or 0),
        "output": int(block.get("output_tokens") or 0),
        "cache_read": int(block.get("cache_read_input_tokens") or block.get("cache_tokens") or 0),
        "cache_write": int(block.get("cache_creation_input_tokens") or block.get("cache_write_input_tokens") or 0),
    }


def extract_text(message) -> str:
    if isinstance(message, str):
        return message
    if not isinstance(message, dict):
        return ""
    content = message.get("content")
    if isinstance(content, str):
        return content
    parts = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(str(b.get("text") or ""))
    return "\n".join(parts).strip()


def _content_len(content) -> int:
    if content is None:
        return 0
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        n = 0
        for b in content:
            if isinstance(b, str):
                n += len(b)
            elif isinstance(b, dict):
                n += len(str(b.get("text") or b.get("content") or ""))
        return n
    if isinstance(content, dict):
        return len(str(content.get("stdout") or content.get("text") or content.get("content") or ""))
    return len(str(content))


def command_key(cmd: str) -> str:
    parts = cmd.strip().split()
    if not parts:
        return "(empty)"
    if len(parts) == 1:
        return parts[0][:40]
    return f"{parts[0]} {parts[1]}"[:48]


def scan_fat_commands(since: datetime | None = None) -> list[dict]:
    pending: dict[str, str] = {}
    groups: dict[str, dict] = {}
    for root in claude_roots():
        for path in iter_jsonl(root):
            try:
                with path.open(encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            ev = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        ts = ev.get("timestamp")
                        when = None
                        if isinstance(ts, str):
                            try:
                                when = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                            except ValueError:
                                when = None
                        if since and when and when < since:
                            continue
                        msg = ev.get("message") if isinstance(ev.get("message"), dict) else ev
                        content = msg.get("content") if isinstance(msg, dict) else None
                        if not isinstance(content, list):
                            continue
                        for b in content:
                            if not isinstance(b, dict):
                                continue
                            if b.get("type") == "tool_use" and str(b.get("name") or "") in {"Bash", "bash"}:
                                inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                                cmd = str(inp.get("command") or "")
                                tid = str(b.get("id") or "")
                                if tid and cmd:
                                    pending[tid] = cmd
                            elif b.get("type") == "tool_result":
                                tid = str(b.get("tool_use_id") or "")
                                if b.get("is_error"):
                                    pending.pop(tid, None)
                                    continue
                                cmd = pending.pop(tid, "")
                                if not cmd:
                                    continue
                                chars = _content_len(b.get("content"))
                                if chars < 200:
                                    continue
                                key = command_key(cmd)
                                g = groups.setdefault(
                                    key,
                                    {"key": key, "count": 0, "chars": 0, "max": 0, "sample": cmd[:80]},
                                )
                                g["count"] += 1
                                g["chars"] += chars
                                if chars > g["max"]:
                                    g["max"] = chars
                                    g["sample"] = cmd[:80]
            except OSError:
                continue
    ranked = sorted(groups.values(), key=lambda g: g["chars"], reverse=True)
    return ranked[:12]


def known_quiet_ids() -> set[str]:
    path = Path.home() / ".claude" / "token-saver" / "quiet.json"
    if not path.is_file():
        path = PACK / "quiet.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    return {str(r.get("id")) for r in data.get("rewrites") or [] if r.get("enabled") is not False}


def scan_transcripts(since: datetime | None = None) -> dict:
    seen = set()
    totals = defaultdict(int)
    sessions = []
    placeholder_in = 0
    real_in = 0
    last_result = ""
    last_when = None

    for root in claude_roots():
        for path in iter_jsonl(root):
            sess = {
                "id": path.stem[:8],
                "project": path.parent.name[-32:],
                "path": str(path),
                "input": 0,
                "output": 0,
                "cache_read": 0,
                "cache_write": 0,
                "turns": 0,
                "model": "",
                "when": None,
                "result": "",
            }
            try:
                with path.open(encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            ev = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        ts = ev.get("timestamp")
                        when = None
                        if isinstance(ts, str):
                            try:
                                when = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                            except ValueError:
                                when = None
                        if since and when and when < since:
                            continue
                        msg = ev.get("message") if isinstance(ev.get("message"), dict) else {}
                        mid = msg.get("id") or ev.get("uuid") or ev.get("requestId")
                        usage = parse_usage_block(msg.get("usage") or ev.get("usage"))
                        if not usage:
                            continue
                        if mid and mid in seen:
                            continue
                        if mid:
                            seen.add(mid)
                        if usage["input"] <= 1:
                            placeholder_in += 1
                        else:
                            real_in += 1
                        for k in ("input", "output", "cache_read", "cache_write"):
                            sess[k] += usage[k]
                            totals[k] += usage[k]
                        sess["turns"] += 1
                        sess["model"] = msg.get("model") or ev.get("model") or sess["model"]
                        if when and (sess["when"] is None or when > sess["when"]):
                            sess["when"] = when
                        text = extract_text(msg)
                        if text:
                            sess["result"] = text
            except OSError:
                continue
            if sess["turns"]:
                sessions.append(sess)
                if sess["when"] and (last_when is None or sess["when"] > last_when):
                    last_when = sess["when"]
                    last_result = sess["result"]

    sessions.sort(key=lambda s: s["when"] or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    billable = totals["input"] + totals["output"] + totals["cache_read"] + totals["cache_write"]
    cache_den = totals["input"] + totals["cache_read"] + totals["cache_write"]
    return {
        "totals": dict(totals),
        "sessions": sessions,
        "billable": billable,
        "cache_hit": (totals["cache_read"] / cache_den) if cache_den else 0.0,
        "placeholder_ratio": placeholder_in / max(1, placeholder_in + real_in),
        "last_result": last_result,
        "roots": [str(p) for p in claude_roots()],
    }


# ── local hook bench ─────────────────────────────────────────

NOISY_GIT = """On branch main
Your branch is up to date with 'origin/main'.

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
	modified:   src/app/index.ts
	modified:   src/app/hooks/useAuth.ts
	modified:   README.md

Untracked files:
  (use "git add <file>..." to include in what will be committed)
	.tmp-cache/
	node_modules/.cache/

no changes added to commit (use "git add" and/or "git commit -a")
"""

NOISY_TEST = "\n".join(
    f"PASS  src/components/Widget{i}.test.ts (12 ms)" for i in range(180)
) + "\n\nTest Suites: 180 passed, 180 total\nTests:       940 passed, 940 total\n"


def run_hook(script: str, payload: dict) -> dict:
    proc = subprocess.run(
        [sys.executable, str(HOOKS / script)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )
    if not proc.stdout.strip():
        return {}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {}


def local_bench() -> dict:
    cases = []

    # quiet-bash: command string before/after
    raw_cmds = ["git status", "git log", "npm test", "pytest", "git status | head"]
    sys.path.insert(0, str(HOOKS))
    try:
        import quiet_bash  # type: ignore

        for cmd in raw_cmds:
            hit = quiet_bash.quiet(cmd)
            new = hit[0] if hit else cmd
            cases.append(
                {
                    "name": f"cmd {cmd}",
                    "before": cmd,
                    "after": new,
                    "rewritten": bool(hit),
                }
            )
    except Exception as exc:
        cases.append({"name": "quiet_bash", "error": str(exc), "before": "", "after": ""})

    # trim-output on a huge successful test log
    payload = {
        "hook_event_name": "PostToolUse",
        "tool_name": "Bash",
        "tool_response": {
            "stdout": NOISY_TEST,
            "stderr": "",
            "interrupted": False,
            "isImage": False,
        },
    }
    out = run_hook("trim_output.py", payload)
    trimmed = (
        ((out.get("hookSpecificOutput") or {}).get("updatedToolOutput") or {}).get("stdout")
        or NOISY_TEST
    )
    fail_payload = dict(payload)
    fail_payload["tool_response"] = {
        "stdout": NOISY_TEST,
        "stderr": "FAIL src/auth.test.ts",
        "interrupted": False,
    }
    fail_out = run_hook("trim_output.py", fail_payload)
    fail_kept = not fail_out

    before_tok = approx_tokens(NOISY_TEST)
    after_tok = approx_tokens(trimmed)
    return {
        "cases": cases,
        "noisy_test_before": before_tok,
        "noisy_test_after": after_tok,
        "noisy_test_preview": trimmed[:900],
        "fail_preserved": fail_kept,
        "git_preview": NOISY_GIT[:400],
    }


# ── live Claude A/B ──────────────────────────────────────────


def claude_bin() -> str | None:
    return shutil.which("claude")


def parse_claude_json(raw: str) -> dict:
    raw = raw.strip()
    if not raw:
        return {"error": "empty CLI output"}
    # stream-json: last result object; plain json: one object
    obj = None
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError:
        last = None
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ev = json.loads(line)
            except json.JSONDecodeError:
                continue
            if ev.get("type") == "result" or "usage" in ev or "total_cost_usd" in ev:
                last = ev
        obj = last
    if not isinstance(obj, dict):
        return {"error": "could not parse Claude JSON", "raw": raw[:400]}
    usage = parse_usage_block(obj.get("usage") or {})
    return {
        "result": obj.get("result") or obj.get("text") or "",
        "session_id": obj.get("session_id") or "",
        "model": obj.get("model") or "",
        "turns": obj.get("num_turns") or obj.get("turns") or 0,
        "cost": float(obj.get("total_cost_usd") or 0),
        "ms": int(obj.get("duration_ms") or 0),
        "is_error": bool(obj.get("is_error")),
        "usage": usage,
        "raw_keys": list(obj.keys()),
    }


def write_bench_settings(on: bool) -> Path:
    name = "bench-settings-on.json" if on else "bench-settings-off.json"
    dest = Path.home() / ".claude" / "token-saver" / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if not on:
        write = {"disableAllHooks": True}
    else:
        hook = HOOKS
        write = {
            "disableAllHooks": False,
            "hooks": {
                "PreToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {
                                "type": "command",
                                "command": f'python3 "{hook / "quiet_bash.py"}"',
                                "timeout": 5,
                            }
                        ],
                    }
                ],
                "PostToolUse": [
                    {
                        "matcher": "Bash",
                        "hooks": [
                            {
                                "type": "command",
                                "command": f'python3 "{hook / "trim_output.py"}"',
                                "timeout": 5,
                            }
                        ],
                    }
                ],
            },
        }
    dest.write_text(json.dumps(write, indent=2) + "\n", encoding="utf-8")
    return dest


def run_claude(prompt: str, settings: Path, max_turns: int, budget: float, model: str | None) -> dict:
    cmd = [
        claude_bin() or "claude",
        "-p",
        prompt,
        "--output-format",
        "json",
        "--permission-mode",
        "dontAsk",
        "--allowedTools",
        "Read,Grep,Glob,Bash",
        "--max-turns",
        str(max_turns),
        "--max-budget-usd",
        str(budget),
        "--settings",
        str(settings),
    ]
    if model:
        cmd.extend(["--model", model])
    try:
        proc = subprocess.run(cmd, text=True, capture_output=True, check=False, timeout=180)
    except subprocess.TimeoutExpired:
        return {"error": "claude timed out (180s)"}
    except FileNotFoundError:
        return {"error": "claude CLI not found on PATH"}
    parsed = parse_claude_json(proc.stdout)
    if proc.returncode != 0 and not parsed.get("usage"):
        parsed["error"] = parsed.get("error") or (proc.stderr or proc.stdout)[-500:]
        parsed["exit"] = proc.returncode
    parsed["stderr"] = (proc.stderr or "")[-300:]
    return parsed


def live_bench(prompt: str, max_turns: int, budget: float, model: str | None) -> dict:
    off = write_bench_settings(False)
    on = write_bench_settings(True)
    control = run_claude(prompt, off, max_turns, budget, model)
    treat = run_claude(prompt, on, max_turns, budget, model)
    return {"control": control, "treat": treat, "prompt": prompt}


# ── screens ──────────────────────────────────────────────────


def usage_lines(u: dict, label: str) -> list[str]:
    total = u.get("input", 0) + u.get("output", 0) + u.get("cache_read", 0) + u.get("cache_write", 0)
    return [
        paint(f" {label}", C.bold),
        f"  input        {fmt_n(u.get('input', 0)):>8}    output     {fmt_n(u.get('output', 0)):>8}",
        f"  cache read   {fmt_n(u.get('cache_read', 0)):>8}    cache wr   {fmt_n(u.get('cache_write', 0)):>8}",
        f"  processed    {fmt_n(total):>8}    est. $     {fmt_usd(est_cost(u)):>8}",
    ]


def render_dash(data: dict) -> str:
    t = data["totals"]
    total = data["billable"]
    hit = f"{data['cache_hit']*100:5.1f}%"
    lines = [
        paint("  Claude Code sessions on this machine", C.dim),
        f"  roots: {', '.join(data['roots']) or '(none found)'}",
        "",
        f"  processed   {paint(fmt_n(total), C.bold, C.white)}     cache hit  {paint(hit, C.green)}",
        f"  {bar(min(1.0, data['cache_hit']))}  cache-read share of input-side tokens",
        "",
        *usage_lines(t, "totals"),
        "",
        paint("  recent sessions  ·  assistant usage summed, not a bill", C.bold),
    ]
    if data["placeholder_ratio"] > 0.4:
        lines.append(
            paint(
                "  note: many input_tokens values look like streaming placeholders; cache numbers are the reliable ones.",
                C.yellow,
            )
        )
    if not data["sessions"]:
        lines.append(paint("  no transcripts yet — run Claude Code once, then dash again", C.yellow))
    for s in data["sessions"][:8]:
        when = s["when"].strftime("%m-%d %H:%M") if s["when"] else "        "
        side = s["input"] + s["cache_read"] + s["cache_write"]
        hit_s = f"{(100 * s['cache_read'] / side):.0f}%" if side else "—"
        lines.append(
            f"  {when}  {s['project']:<20}  read {fmt_n(s['cache_read']):>6}  write {fmt_n(s['cache_write']):>6}  new {fmt_n(s['input']):>6}  hit {hit_s:>4}"
        )
    snippet = (data["last_result"] or "").strip().splitlines()
    if snippet:
        lines.append("")
        lines.append(paint("  last assistant snippet", C.bold))
        for row in snippet[:8]:
            lines.append("  " + row[:80])

    fat = data.get("fat") or []
    if fat:
        covered = known_quiet_ids()
        lines.append("")
        lines.append(paint("  noisiest bash this window", C.bold))
        lines.append(paint("  grouped by first two tokens · est. tokens = chars/4 · errors skipped", C.dim))
        for g in fat[:8]:
            toks = max(1, g["chars"] // 4)
            flag = ""
            sample_l = g["sample"].lower()
            if any(k.replace("-", " ") in sample_l or k.split("-")[0] in sample_l for k in covered):
                flag = paint("  map", C.green)
            else:
                flag = paint("  add to quiet.json", C.yellow)
            lines.append(
                f"  {g['key']:<22}  {g['count']:>3}×  {fmt_n(toks):>6} tok  max {fmt_n(g['max']//4)}{flag}"
            )
            lines.append(paint(f"     {g['sample']}", C.dim))
    lines.append("")
    lines.append(paint("  read vs write is request accounting, not tokens saved. Named miss cause is on /usage.", C.dim))
    return box("TOKEN SAVER  ·  dash", lines)


def render_local(data: dict) -> str:
    saved = data["noisy_test_before"] - data["noisy_test_after"]
    pct = (saved / data["noisy_test_before"] * 100) if data["noisy_test_before"] else 0
    lines = [
        paint("  local hook bench  ·  no Claude call  ·  $0", C.dim),
        "",
        paint("  quiet-bash rewrites", C.bold),
    ]
    for c in data["cases"]:
        if c.get("error"):
            lines.append(paint(f"  error: {c['error']}", C.red))
            continue
        flag = paint("REWROTE", C.green) if c.get("rewritten") else paint("left", C.dim)
        lines.append(f"  {flag}  {c['before']:<22} → {c['after']}")
    lines += [
        "",
        paint("  trim-output on a 180-suite test log", C.bold),
        f"  before   {fmt_n(data['noisy_test_before'])} tok",
        f"  after    {fmt_n(data['noisy_test_after'])} tok",
        f"  saved    {paint(fmt_n(saved) + f'  ({pct:.0f}%)', C.green, C.bold)}",
        f"  failures left intact: {paint('yes' if data['fail_preserved'] else 'NO', C.green if data['fail_preserved'] else C.red)}",
        "",
        paint("  trimmed result preview", C.bold),
    ]
    for row in data["noisy_test_preview"].splitlines()[:12]:
        lines.append("  " + row[:80])
    lines.append("")
    lines.append(paint("  This is command-output tokens avoided, not an API bill.", C.dim))
    lines.append(paint("  For tokens Claude actually billed, run:  python3 scripts/tui.py bench --live", C.dim))
    return box("TOKEN SAVER  ·  bench  ·  local", lines)


def render_live(data: dict) -> str:
    c, t = data["control"], data["treat"]
    lines = [
        paint(f"  prompt: {data['prompt'][:70]}", C.dim),
        "",
    ]
    if c.get("error") or t.get("error"):
        if c.get("error"):
            lines.append(paint(f"  OFF arm error: {c['error']}", C.red))
        if t.get("error"):
            lines.append(paint(f"  ON  arm error: {t['error']}", C.red))
        lines.append("")

    def arm(label: str, run: dict) -> list[str]:
        u = run.get("usage") or {}
        return [
            paint(f" {label}", C.bold),
            f"  model {run.get('model') or '—':<22} turns {run.get('turns') or 0}   {run.get('ms') or 0} ms",
            f"  input {fmt_n(u.get('input', 0)):>7}  output {fmt_n(u.get('output', 0)):>7}  cache r {fmt_n(u.get('cache_read', 0)):>7}",
            f"  cost  {fmt_usd(float(run.get('cost') or est_cost(u)))}",
        ]

    lines += arm("OFF  hooks disabled", c)
    lines.append("")
    lines += arm("ON   quiet-bash + trim-output", t)
    cu, tu = c.get("usage") or {}, t.get("usage") or {}
    c_tot = sum(cu.get(k, 0) for k in ("input", "output", "cache_read", "cache_write"))
    t_tot = sum(tu.get(k, 0) for k in ("input", "output", "cache_read", "cache_write"))
    saved = c_tot - t_tot
    if c_tot:
        pct = saved / c_tot * 100
        tone = C.green if saved > 0 else C.yellow
        lines += [
            "",
            paint(" SAVED", C.bold),
            "  " + paint(f"{fmt_n(saved)} tokens  ({pct:+.1f}%)", tone, C.bold),
            f"  $ delta  {fmt_usd(float(c.get('cost') or 0) - float(t.get('cost') or 0))}",
        ]
    lines.append("")
    lines.append(paint("  result OFF", C.bold))
    for row in str(c.get("result") or "").splitlines()[:8] or [paint("  (empty)", C.dim)]:
        lines.append("  " + row[:80])
    lines.append(paint("  result ON", C.bold))
    for row in str(t.get("result") or "").splitlines()[:8] or [paint("  (empty)", C.dim)]:
        lines.append("  " + row[:80])
    return box("TOKEN SAVER  ·  bench  ·  live Claude A/B", lines)


def header() -> str:
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    return paint(f"  token-saver   {now}", C.mag, C.bold)


# ── cli ──────────────────────────────────────────────────────


def main() -> int:
    p = argparse.ArgumentParser(description="Token-saver dashboard and Claude bench")
    sub = p.add_subparsers(dest="cmd")
    d = sub.add_parser("dash", help="Read local Claude Code transcripts (free)")
    d.add_argument("--days", type=int, default=7)
    d.add_argument("--watch", action="store_true")
    b = sub.add_parser("bench", help="Local hook bench, or --live A/B against Claude")
    b.add_argument("--live", action="store_true")
    b.add_argument("--prompt", default="Run git status, then name the 3 most recently edited files. Do not modify files.")
    b.add_argument("--max-turns", type=int, default=4)
    b.add_argument("--budget", type=float, default=0.50)
    b.add_argument("--model", default=None)
    b.add_argument("--yes", action="store_true", help="Skip live-spend confirm")
    args = p.parse_args()
    cmd = args.cmd or "dash"

    print(header())
    print()

    if cmd == "dash":
        since = datetime.now(timezone.utc) - timedelta(days=args.days)
        while True:
            data = scan_transcripts(since)
            data["fat"] = scan_fat_commands(since)
            if args.watch:
                sys.stdout.write("\033[2J\033[H")
                print(header())
                print()
            print(render_dash(data))
            if not args.watch:
                break
            time.sleep(2)
        return 0

    if cmd == "bench" and not args.live:
        print(render_local(local_bench()))
        return 0

    if cmd == "bench" and args.live:
        if not claude_bin():
            print(paint("claude CLI not on PATH. Local bench instead:\n", C.red))
            print(render_local(local_bench()))
            return 1
        print(box("LIVE BENCH", [
            "  This runs Claude Code twice (hooks OFF then ON).",
            f"  Prompt : {args.prompt[:70]}",
            f"  Cap    : {args.max_turns} turns / ${args.budget:.2f} per arm",
            "  Tools  : Read, Grep, Glob, Bash   permission-mode=dontAsk",
            "  Results of both arms will be shown so you can judge quality.",
        ]))
        if not args.yes:
            ans = input(paint("\n  Spend tokens on a live A/B? [y/N] ", C.yellow)).strip().lower()
            if ans not in {"y", "yes"}:
                print(paint("  cancelled. Running local bench.", C.dim))
                print()
                print(render_local(local_bench()))
                return 0
        print(paint("\n  running OFF arm…", C.dim))
        print(paint("  running ON arm…", C.dim))
        result = live_bench(args.prompt, args.max_turns, args.budget, args.model)
        print()
        print(render_live(result))
        return 0

    p.print_help()
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
