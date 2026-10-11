#!/usr/bin/env python3
"""Check the token-saver subagent cache-lapse guard against real sessions.

The mod (plugins/token-saver/hooks/register.js) counts a subagent request as a cache lapse when it comes more than
5 minutes after that agent's previous request, writes its context again, and hits the cache for less than half of what
it sent. This script applies the same rule to the transcripts Claude Code writes on disk, which also record the TTL
every cache write actually used (usage.cache_creation.ephemeral_5m_input_tokens / ephemeral_1h_input_tokens).

  python3 -I scripts/lapse-check.py scan [--days 30] [--project PATH]   every past subagent run: lapses per agent type, 5m vs 1h writes
  python3 -I scripts/lapse-check.py snapshot                             copy the mod's $.store before a live run; prints the copy's path
  python3 -I scripts/lapse-check.py drive [--run]                        the `claude -p` command that makes one subagent lapse on purpose
  python3 -I scripts/lapse-check.py check SESSION_ID --baseline SNAP     transcript lapses for that session vs what the mod stored
  python3 -I scripts/lapse-check.py selftest                             snapshot, drive --run, check: one command, about 6 minutes

Stdlib only. Reads ~/.claude/projects/**/subagents/*.jsonl and ~/.claude/plugins/store/token-saver_*.json; writes nothing
but the snapshot copy under the system temp folder.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

TTL_S = 300                 # the 5-minute subagent cache
LAPSE_RE = 1.15             # a lapse write at 1.25× that a longer cache would have served at 0.1×
LONG_PREMIUM = 0.75         # what every other write would have cost extra at the 1-hour price (2× − 1.25×)
MIN_VERSION = (0, 3, 25)    # the first mod version that records subagent lapses


def config_dir() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR") or (Path.home() / ".claude"))


def ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def fmt_k(n: float) -> str:
    n = max(0, n)
    if n >= 999_500:
        return f"{n / 1e6:.1f}".rstrip("0").rstrip(".") + "M"
    if n >= 1000:
        return f"{n / 1000:.1f}".rstrip("0").rstrip(".") + "k"
    return str(round(n))


def requests_of(path: Path) -> list[dict]:
    """One row per model request (a streamed reply repeats its usage on every content block; dedupe on message.id)."""
    seen: set[str] = set()
    rows: list[dict] = []
    try:
        fh = path.open(encoding="utf-8", errors="replace")
    except OSError:
        return rows
    with fh:
        for line in fh:
            try:
                o = json.loads(line)
            except ValueError:
                continue
            m = o.get("message") or {}
            u = m.get("usage")
            if o.get("type") != "assistant" or not isinstance(u, dict) or not o.get("timestamp"):
                continue
            mid = m.get("id") or o.get("uuid")
            if mid in seen:
                continue
            seen.add(mid)
            cc = u.get("cache_creation") if isinstance(u.get("cache_creation"), dict) else {}
            rows.append({
                "at": ts(o["timestamp"]),
                "input": int(u.get("input_tokens") or 0),
                "write": int(u.get("cache_creation_input_tokens") or 0),
                "read": int(u.get("cache_read_input_tokens") or 0),
                "write_5m": int(cc.get("ephemeral_5m_input_tokens") or 0),
                "write_1h": int(cc.get("ephemeral_1h_input_tokens") or 0),
                "model": m.get("model") or "",
            })
    rows.sort(key=lambda r: r["at"])
    return rows


def hit_pct(r: dict) -> int:
    sent = r["input"] + r["read"] + r["write"]
    return round(100 * r["read"] / sent) if sent else 0


def analyse(rows: list[dict]) -> dict:
    """The mod's rule, applied to one agent's requests."""
    out = {"steps": len(rows), "lapses": 0, "lapse_write": 0, "other_write": 0, "write_5m": 0, "write_1h": 0,
           "gap_hits": 0, "max_gap_s": 0, "lapse_gaps": []}
    prev = None
    for r in rows:
        out["write_5m"] += r["write_5m"]
        out["write_1h"] += r["write_1h"]
        if prev is not None:
            gap = r["at"] - prev["at"]
            out["max_gap_s"] = max(out["max_gap_s"], gap)
            if gap > TTL_S and r["write"] > 0 and hit_pct(r) < 50:
                out["lapses"] += 1
                out["lapse_write"] += r["write"]
                out["lapse_gaps"].append((round(gap / 60), r["write"], hit_pct(r)))
                prev = r
                continue
            if gap > TTL_S:
                out["gap_hits"] += 1
        out["other_write"] += r["write"]
        prev = r
    out["cost"] = round(out["lapse_write"] * 1.25)
    out["net_1h"] = round(LAPSE_RE * out["lapse_write"] - LONG_PREMIUM * out["other_write"])
    return out


def agent_type_of(agent_jsonl: Path) -> str:
    meta = agent_jsonl.with_suffix("").with_suffix(".meta.json")
    try:
        return str(json.loads(meta.read_text(encoding="utf-8")).get("agentType") or "subagent")
    except (OSError, ValueError):
        return "subagent"


def agent_files(project: str | None, session: str | None, days: int | None) -> list[Path]:
    root = config_dir() / "projects"
    pattern = str(root / (slug_of(project) if project else "*") / (session or "*") / "subagents" / "agent-*.jsonl")
    files = [Path(p) for p in glob.glob(pattern)]
    if days:
        cutoff = time.time() - days * 86400
        files = [f for f in files if f.stat().st_mtime >= cutoff]
    return sorted(files)


def slug_of(path: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(Path(path).resolve()))


def main_thread_split(agent_file: Path) -> tuple[int, int]:
    """5m and 1h cache writes of the session that owns this agent, for the comparison line."""
    session_jsonl = agent_file.parents[1].with_suffix(".jsonl")
    w5 = w1 = 0
    for r in requests_of(session_jsonl):
        w5 += r["write_5m"]
        w1 += r["write_1h"]
    return w5, w1


def cmd_scan(args: argparse.Namespace) -> int:
    files = agent_files(args.project, None, args.days)
    if not files:
        print("no subagent transcripts found under", config_dir() / "projects")
        return 1
    by_type: dict[str, dict] = {}
    sessions: set[Path] = set()
    for f in files:
        a = analyse(requests_of(f))
        if not a["steps"]:
            continue
        t = by_type.setdefault(agent_type_of(f), {"runs": 0, "lapses": 0, "lapse_write": 0, "other_write": 0, "write_5m": 0, "write_1h": 0, "gap_hits": 0, "runs_lapsed": 0})
        t["runs"] += 1
        t["runs_lapsed"] += 1 if a["lapses"] else 0
        for k in ("lapses", "lapse_write", "other_write", "write_5m", "write_1h", "gap_hits"):
            t[k] += a[k]
        sessions.add(f.parents[1].with_suffix(".jsonl"))
    main5 = main1 = 0
    for s in sessions:
        for r in requests_of(s):
            main5 += r["write_5m"]
            main1 += r["write_1h"]
    print(f"Agents that waited over 5 minutes and had to re-read what they had: {len(files)} agent runs, {len(sessions)} sessions{f', last {args.days} days' if args.days else ''}")
    print(f"{'agent':<22}{'runs':>6}{'waited':>8}{'re-reads':>9}{'tokens':>11}{'cost':>11}  {'1-hour cache?':<18}")
    tot = {"runs": 0, "lapses": 0, "cost": 0, "net": 0, "gap_hits": 0}
    for name, t in sorted(by_type.items(), key=lambda kv: -kv[1]["lapse_write"]):
        cost = round(t["lapse_write"] * 1.25)
        net = round(LAPSE_RE * t["lapse_write"] - LONG_PREMIUM * t["other_write"])
        tot["runs"] += t["runs"]; tot["lapses"] += t["lapses"]; tot["cost"] += cost; tot["net"] += max(0, net); tot["gap_hits"] += t["gap_hits"]
        verdict = f"saves ≈ {fmt_k(net)} tokens" if net > 0 else ("costs more than it saves" if t["lapses"] else "no waits, leave it")
        print(f"{name:<22}{t['runs']:>6}{t['runs_lapsed']:>8}{t['lapses']:>9}{fmt_k(t['lapse_write']):>11}{fmt_k(cost):>11}  {verdict:<18}")
    print(f"{'all agents':<22}{tot['runs']:>6}{'':>8}{tot['lapses']:>9}{'':>11}{fmt_k(tot['cost']):>11}  {'saves ≈ ' + fmt_k(tot['net']) + ' tokens' if tot['net'] else 'nothing to change'}")
    print()
    all5 = not any(t['write_1h'] for t in by_type.values())
    print("How to read it: 'waited' is runs with a step over 5 minutes; 're-reads' is how many times an agent then re-read everything it had;")
    print("'tokens' is what it re-read; 'cost' is that at the 1.25× price of writing it back. '1-hour cache?' says whether giving that agent a")
    print("1-hour cache (cacheTtl: 1h under experimental in its agent file) would come out ahead, since every write then costs 2× instead of 1.25×.")
    print(f"Agents here remember for 5 minutes{' (every write confirms it)' if all5 else ' mostly; some 1-hour writes were seen'}; the main conversation remembers for an hour"
          f" ({fmt_k(main1)} tokens written at 1 hour, {fmt_k(main5)} at 5 minutes).")
    if tot['gap_hits']:
        print(f"Not counted: {tot['gap_hits']} wait{'s' if tot['gap_hits'] != 1 else ''} right at 5 minutes where the agent still remembered.")
    return 0


def store_path() -> Path | None:
    cands = sorted(glob.glob(str(config_dir() / "plugins" / "store" / "token-saver_token-saver-*.json")))
    return Path(cands[-1]) if cands else None


def read_store(path: Path | None) -> dict:
    if not path or not path.is_file():
        return {}
    try:
        d = json.loads(path.read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def lapse_rows(store: dict) -> dict[str, dict]:
    return {k[7:]: v for k, v in store.items() if k.startswith("lapses:") and isinstance(v, dict)}


def installed_version() -> tuple[int, ...] | None:
    try:
        d = json.loads((config_dir() / "plugins" / "installed_plugins.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    for key, entries in (d.get("plugins") or d).items():
        if str(key).startswith("token-saver@") and isinstance(entries, list) and entries:
            v = str(entries[0].get("version") or "")
            return tuple(int(x) for x in v.split(".") if x.isdigit()) or None
    return None


def cmd_snapshot(args: argparse.Namespace) -> int:
    src = store_path()
    dst = Path(tempfile.gettempdir()) / f"token-saver-store-{int(time.time())}.json"
    if src and src.is_file():
        shutil.copy2(src, dst)
    else:
        dst.write_text("{}", encoding="utf-8")
    print(dst)
    return 0


DRIVE_PROMPT = (
    "This is a cache test. Use the Agent tool once, subagent_type Explore, with exactly this prompt and nothing else: "
    "\"Step 1: run the Bash tool with command `python3 -c \"import time; time.sleep(320)\"` and timeout 400000 (a plain sleep is blocked by the harness; do not use it). Step 2: after it returns, run `ls` with the Bash tool. "
    "Step 3: reply with the single word done.\" When the agent returns, reply with the single word done."
)


def drive_cmd(cwd: Path) -> list[str]:
    return ["claude", "-p", DRIVE_PROMPT, "--output-format", "json", "--max-turns", "6",
            "--allowedTools", "Agent", "Bash(python3:*)", "Bash(ls)", "--add-dir", str(cwd)]


def cmd_drive(args: argparse.Namespace) -> int:
    cmd = drive_cmd(Path.cwd())
    v = installed_version()
    if v is None or v < MIN_VERSION:
        print(f"WARN installed token-saver is {'.'.join(map(str, v)) if v else 'unknown'}; lapses are recorded from {'.'.join(map(str, MIN_VERSION))}. Release first (the release skill), then run this.")
    if not args.run:
        print("Run from an interactive shell (about 6 minutes; the subagent re-writes its context once, a few tens of thousands of tokens):")
        print("  " + " ".join(json.dumps(c) if " " in c else c for c in cmd))
        return 0
    print("driving one subagent through a 320 s Python sleep …", file=sys.stderr)
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=900)
    if proc.returncode != 0:
        print(proc.stderr.strip() or proc.stdout.strip(), file=sys.stderr)
        return proc.returncode
    try:
        out = json.loads(proc.stdout)
    except ValueError:
        print(proc.stdout)
        return 1
    sid = out.get("session_id") or ""
    print(f"session {sid}  {round(time.time() - t0)} s  cost ${out.get('total_cost_usd', 0):.3f}  result: {str(out.get('result', ''))[:80]}")
    print(sid)
    return 0 if sid else 1


def cmd_check(args: argparse.Namespace) -> int:
    files = agent_files(None, args.session, None)
    if not files:
        print(f"no subagent transcripts for session {args.session}")
        return 1
    expected: dict[str, dict] = {}
    print(f"Session {args.session}: {len(files)} agent run(s)")
    for f in files:
        a = analyse(requests_of(f))
        t = agent_type_of(f)
        e = expected.setdefault(t, {"lapses": 0, "cost": 0})
        e["lapses"] += a["lapses"]; e["cost"] += a["cost"]
        gaps = ", ".join(f"after {g}m re-read {fmt_k(w)} tokens (remembered {h}%)" for g, w, h in a["lapse_gaps"]) or "none"
        print(f"  {t:<18} {a['steps']} steps, longest wait {round(a['max_gap_s'] / 60)}m, re-reads: {gaps}; wrote {fmt_k(a['write_5m'])} tokens at 5 minutes, {fmt_k(a['write_1h'])} at 1 hour")
    before = lapse_rows(read_store(Path(args.baseline))) if args.baseline else {}
    after = lapse_rows(read_store(store_path()))
    ok = True
    print("What the plugin recorded (its store, cumulative) against the transcripts:")
    for t, e in expected.items():
        got = (after.get(t, {}).get("allCount") or 0) - (before.get(t, {}).get("allCount") or 0)
        got_tok = (after.get(t, {}).get("allTok") or 0) - (before.get(t, {}).get("allTok") or 0)
        mark = "PASS" if got == e["lapses"] and (e["lapses"] == 0 or abs(got_tok - e["cost"]) <= max(50, e["cost"] * 0.02)) else "FAIL"
        ok &= mark == "PASS"
        print(f"  {mark} {t:<18} transcript: {e['lapses']} re-read(s), {fmt_k(e['cost'])} tokens at 1.25×   plugin: {got} re-read(s), {fmt_k(got_tok)} tokens")
    if not args.baseline:
        print("  (no --baseline: the store is cumulative, so a delta could not be formed; counts above are the whole store)")
    if not after and expected and any(e["lapses"] for e in expected.values()):
        print("  store has no lapses:* rows at all: the mod did not record (not installed at 0.3.25+, or the session ran without it)")
        ok = False
    return 0 if ok else 1


def cmd_selftest(args: argparse.Namespace) -> int:
    snap = Path(tempfile.gettempdir()) / f"token-saver-store-{int(time.time())}.json"
    src = store_path()
    if src and src.is_file():
        shutil.copy2(src, snap)
    else:
        snap.write_text("{}", encoding="utf-8")
    ns = argparse.Namespace(run=True)
    buf, real = [], sys.stdout
    class Tee:
        def write(self, s): buf.append(s); real.write(s)
        def flush(self): real.flush()
    sys.stdout = Tee()
    try:
        rc = cmd_drive(ns)
    finally:
        sys.stdout = real
    if rc:
        return rc
    sid = "".join(buf).strip().splitlines()[-1]
    time.sleep(2)   # the store flushes after turn.complete
    return cmd_check(argparse.Namespace(session=sid, baseline=str(snap)))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("scan"); s.add_argument("--days", type=int, default=0); s.add_argument("--project")
    sub.add_parser("snapshot")
    d = sub.add_parser("drive"); d.add_argument("--run", action="store_true")
    c = sub.add_parser("check"); c.add_argument("session"); c.add_argument("--baseline")
    sub.add_parser("selftest")
    args = p.parse_args()
    return {"scan": cmd_scan, "snapshot": cmd_snapshot, "drive": cmd_drive, "check": cmd_check, "selftest": cmd_selftest}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
