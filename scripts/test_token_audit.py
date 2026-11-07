#!/usr/bin/env python3
"""Self-test for the audit: measured startup from fixture transcripts, attribution by source, duplicates, the
token-count API path, and the Agents section. Runs in a temp config dir and a temp project; never touches ~/.claude.

    python3 -I scripts/test_token_audit.py
"""
from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

PACK = Path(__file__).resolve().parents[1]
SCRIPT = PACK / "scripts" / "token-audit.py"


def write_agent(folder: Path, name: str, frontmatter_extra: str = "") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    f = folder / f"{name}.md"
    f.write_text(f"---\nname: {name}\ndescription: test agent\n{frontmatter_extra}---\nYou are {name}.\n", encoding="utf-8")
    return f


class SubagentAudit(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="token-audit-test-"))
        self.cfg = self.tmp / ".claude"
        self.cfg.mkdir()
        self.proj = self.tmp / "proj"
        (self.proj / ".claude").mkdir(parents=True)
        (self.proj / "CLAUDE.md").write_text("# test\n", encoding="utf-8")
        write_agent(self.cfg / "agents", "researcher", "experimental:\n  cacheTtl: 1h\n")
        write_agent(self.proj / ".claude" / "agents", "builder")
        write_agent(self.proj / ".claude" / "agents", "inline", "experimental: { cacheTtl: 5m }\n")
        self.base_env = {k: v for k, v in os.environ.items() if k not in ("FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", "ENABLE_PROMPT_CACHING_1H", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL")}
        self.base_env["CLAUDE_CONFIG_DIR"] = str(self.cfg)
        self.base_env["HOME"] = str(self.tmp)

    def run_audit(self, env: dict | None = None) -> dict:
        proc = subprocess.run(
            [sys.executable, "-I", str(SCRIPT), "--json"], cwd=self.proj, env=env or self.base_env,
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_agent_files_and_their_ttl(self) -> None:
        r = self.run_audit()
        by = {(a["scope"], a["name"]): a["cacheTtl"] for a in r["agents"]}
        self.assertEqual(by, {("user", "researcher"): "1h", ("project", "builder"): None, ("project", "inline"): "5m"})
        self.assertIsNone(r["ttl_override"])
        self.assertEqual(r["ttl_sources"], [])
        self.assertFalse(any("sets how long every agent" in w for w in r["warnings"]))

    def test_env_override_wins_and_warns(self) -> None:
        env = {**self.base_env, "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL": "5m"}
        r = self.run_audit(env)
        self.assertEqual(r["ttl_override"], {"source": "environment", "key": "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", "value": "5m"})
        self.assertTrue(any("CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m in environment sets how long every agent's cache lasts" in w for w in r["warnings"]))

    def test_force_5m_outranks_the_ttl_env(self) -> None:
        env = {**self.base_env, "FORCE_PROMPT_CACHING_5M": "1", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL": "1h"}
        r = self.run_audit(env)
        self.assertEqual(r["ttl_override"]["key"], "FORCE_PROMPT_CACHING_5M")
        self.assertEqual([s["key"] for s in r["ttl_sources"]], ["FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"])

    def test_settings_file_override_and_env_block(self) -> None:
        (self.proj / ".claude" / "settings.local.json").write_text(json.dumps({"subagentPromptCacheTtl": "1h"}), encoding="utf-8")
        (self.cfg / "settings.json").write_text(json.dumps({"env": {"CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL": "5m"}}), encoding="utf-8")
        r = self.run_audit()
        self.assertEqual(r["ttl_override"], {"source": "~/.claude/settings.json", "key": "env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", "value": "5m"})
        self.assertIn({"source": ".claude/settings.local.json", "key": "subagentPromptCacheTtl", "value": "1h"}, r["ttl_sources"])

    def test_default_only_agents_get_the_hint_not_an_override_warning(self) -> None:
        (self.cfg / "agents" / "researcher.md").unlink()
        (self.proj / ".claude" / "agents" / "inline.md").unlink()
        r = self.run_audit()
        self.assertTrue(any("1 agent file keeps the default" in w for w in r["warnings"]))

    def test_text_render_has_the_section(self) -> None:
        proc = subprocess.run([sys.executable, "-I", str(SCRIPT)], cwd=self.proj, env=self.base_env, capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("Agents: how long each one remembers what it read", proc.stdout)
        self.assertIn("user/researcher", proc.stdout)
        self.assertIn("researcher                   1 hour", proc.stdout)
        self.assertIn("5 minutes (default)", proc.stdout)
        self.assertIn("override      none: each agent file decides", proc.stdout)
        self.assertNotIn(" tok ", proc.stdout)


def sanitize(p: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(p))


def turn_lines(ts: str, usage: tuple[int, int, int], pre: list[dict] | None = None, model: str = "claude-opus-5-5") -> list[dict]:
    i, w, r = usage
    return [*(pre or []), {"type": "assistant", "timestamp": ts, "isSidechain": False, "version": "2.1.300",
            "message": {"model": model, "usage": {"input_tokens": i, "cache_creation_input_tokens": w, "cache_read_input_tokens": r, "output_tokens": 9}}}]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(x) + "\n" for x in rows), encoding="utf-8")


def att(**kw) -> dict:
    return {"type": "attachment", "attachment": kw}


RULE = "# Token budget\n- One task per session. Topic change means clear.\n- Prefer a short, cache-stable session.\n- Quiet flags on tests and git.\n"
SKILL_BODY = "Very long skill body that is never listed at startup. " * 200


class StartupAudit(unittest.TestCase):
    """A config dir and project laid out like a real machine, with three sessions of transcripts."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="token-audit-startup-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = self.tmp / ".claude"
        self.proj = self.tmp / "proj"
        (self.proj / ".claude" / "rules").mkdir(parents=True)
        (self.cfg / "rules").mkdir(parents=True)
        # User CLAUDE.md imports a shared file, the way ~/.claude/CLAUDE.md imports ~/agentic/AGENTS.md.
        (self.tmp / "agentic").mkdir()
        (self.tmp / "agentic" / "AGENTS.md").write_text("# Agentic\nClaude plans and reviews. Codex implements.\n", encoding="utf-8")
        (self.cfg / "CLAUDE.md").write_text("@~/agentic/AGENTS.md\n", encoding="utf-8")
        (self.proj / "CLAUDE.md").write_text("# proj\nSee @docs/map.md for the layout. Mail me at a@b.c\n", encoding="utf-8")
        (self.proj / "docs").mkdir()
        (self.proj / "docs" / "map.md").write_text("src/ holds the code.\n", encoding="utf-8")
        # The same rule in both places, plus a path-scoped rule that stays cold.
        (self.cfg / "rules" / "token-budget.md").write_text(RULE, encoding="utf-8")
        (self.proj / ".claude" / "rules" / "token-budget.md").write_text(RULE + "- One extra project line here.\n", encoding="utf-8")
        (self.proj / ".claude" / "rules" / "swift.md").write_text("---\npaths: ['**/*.swift']\n---\nSwift rules.\n", encoding="utf-8")
        # settings.json is never sent; make it big so counting it would show.
        (self.proj / ".claude" / "settings.json").write_text(json.dumps({"permissions": {"allow": ["Bash(x)"] * 500}}), encoding="utf-8")
        mem = self.cfg / "projects" / sanitize(self.proj) / "memory"
        mem.mkdir(parents=True)
        (mem / "MEMORY.md").write_text("- [Ship](ship.md) — for teammates\n", encoding="utf-8")
        self.write_skill(self.cfg / "skills" / "plan", "plan", "Turn a brief into plan.md.")
        self.write_skill(self.cfg / "skills" / "hidden", "hidden", "Never listed.", extra="disable-model-invocation: true\n")
        # One enabled plugin, one installed but disabled, one synced plugin switched off.
        on, off = self.tmp / "plugins" / "on", self.tmp / "plugins" / "off"
        self.write_skill(on / "skills" / "deploy", "deploy", "Ship it.")
        (on / "commands").mkdir(parents=True)
        (on / "commands" / "go.md").write_text("Run the deploy now.\n", encoding="utf-8")
        write_agent(on / "agents", "runner")
        self.write_skill(off / "skills" / "figma-use", "figma-use", "Off plugin skill.")
        synced = self.cfg / "plugins" / "synced" / "bucket" / "data"
        self.write_skill(synced / "skills" / "sql", "sql", "Synced but disabled.")
        (self.cfg / "plugins" / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {
            "on@m": [{"installPath": str(on)}], "off@m": [{"installPath": str(off)}]}}), encoding="utf-8")
        (self.cfg / "settings.json").write_text(json.dumps({"enabledPlugins": {"on@m": True, "off@m": False, "data@synced": False}}), encoding="utf-8")

        self.tdir = self.cfg / "projects" / sanitize(self.proj)
        self.instr_files = [
            {"path": str(self.cfg / "CLAUDE.md"), "type": "User", "content": "@~/agentic/AGENTS.md"},
            {"path": str(self.tmp / "agentic" / "AGENTS.md"), "type": "User", "content": "# Agentic\nClaude plans and reviews. Codex implements.\n"},
            {"path": str(self.cfg / "rules" / "token-budget.md"), "type": "User", "content": RULE},
            {"path": str(self.proj / ".claude" / "rules" / "token-budget.md"), "type": "Project", "content": RULE},
            {"path": str(self.proj / "CLAUDE.md"), "type": "Project", "content": "# proj\n"},
            {"path": str(mem / "MEMORY.md"), "type": "AutoMem", "content": "- [Ship](ship.md)\n"},
        ]
        latest_pre = [
            att(type="hook_success", content="Token budget active."),
            {"type": "user", "message": {"role": "user", "content": "Rework the audit please."}},
            att(type="deferred_tools_delta", addedLines=["CronCreate", "mcp__abc__list_projects", "mcp__abc__generate_image"]),
            att(type="agent_listing_delta", addedLines=["- on:runner: test agent"]),
            att(type="mcp_instructions_delta", addedBlocks=["## abc\nUse abc tools for images."]),
            att(type="skill_listing", content="- plan: Turn a brief into plan.md.\n- on:deploy: Ship it.\n- data:sql: Synced but disabled.\n"),
            att(type="instructions", files=self.instr_files),
            att(type="prompt_snapshot", systemPrompt=["You are an agent.", "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__", "# Memory\nYou have memory."]),
        ]
        write_jsonl(self.tdir / "s1.jsonl", turn_lines("2026-10-10T10:00:00Z", (2, 30000, 40000)))
        # A synthetic error turn comes first in s2 and must be skipped, as must a sidechain turn.
        write_jsonl(self.tdir / "s2.jsonl", [
            {"type": "assistant", "timestamp": "2026-10-12T10:00:00Z", "message": {"model": "<synthetic>", "usage": {"input_tokens": 0}}},
            {"type": "assistant", "isSidechain": True, "timestamp": "2026-10-12T10:00:01Z", "message": {"model": "m", "usage": {"input_tokens": 5}}},
            *turn_lines("2026-10-12T10:00:02Z", (2, 1000, 70000)),
        ])
        # A worktree session of the same project counts; another project and subagent files do not.
        wt = self.cfg / "projects" / (sanitize(self.proj) + "--claude-worktrees-x")
        write_jsonl(wt / "s3.jsonl", turn_lines("2026-10-17T10:00:00Z", (2, 30043, 44090), latest_pre))
        write_jsonl(self.cfg / "projects" / (sanitize(self.proj) + "-other") / "o.jsonl", turn_lines("2026-10-18T00:00:00Z", (1, 1, 1)))
        write_jsonl(wt / "s3" / "subagents" / "a.jsonl", turn_lines("2026-10-18T00:00:00Z", (1, 1, 1)))

        self.env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL")}
        self.env.update(CLAUDE_CONFIG_DIR=str(self.cfg), HOME=str(self.tmp))

    def write_skill(self, folder: Path, name: str, desc: str, extra: str = "") -> None:
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {desc}\n{extra}---\n{SKILL_BODY}\n", encoding="utf-8")

    def run_audit(self, *args: str, env: dict | None = None) -> subprocess.CompletedProcess:
        proc = subprocess.run([sys.executable, "-I", str(SCRIPT), *args], cwd=self.proj, env=env or self.env, capture_output=True, text=True, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc

    def audit(self, *args: str, env: dict | None = None) -> dict:
        return json.loads(self.run_audit("--json", *args, env=env).stdout)

    def src(self, r: dict) -> dict:
        return {s["key"]: s for s in r["sources"]}

    def test_measured_latest_median_and_change(self) -> None:
        m = self.audit()["measured"]
        self.assertEqual([s["total"] for s in m["sessions"]], [70002, 71002, 74135])
        self.assertEqual((m["latest"], m["median"], m["change"]), (74135, 71002, 4133))
        last = m["sessions"][-1]
        self.assertEqual((last["input"], last["cache_write"], last["cache_read"]), (2, 30043, 44090))

    def test_sessions_flag_limits_the_window(self) -> None:
        m = self.audit("--sessions", "2")["measured"]
        self.assertEqual([s["session"] for s in m["sessions"]], ["s2", "s3"])

    def test_attribution_plus_remainder_equals_measured(self) -> None:
        r = self.audit()
        self.assertEqual(r["attributed"] + r["remainder"], r["measured"]["latest"])
        self.assertEqual(r["attributed"], sum(s["latest"] for s in r["sources"]))
        self.assertGreater(r["remainder"], 0)
        self.assertEqual(r["counting"], "estimate")

    def test_latest_column_reads_what_the_transcript_says_was_sent(self) -> None:
        s = self.src(self.audit())
        for key in ("claude_md_user", "rules_user", "rules_project", "memory", "skills", "agents", "mcp_tools", "mcp_instructions", "system_prompt", "first_message"):
            self.assertEqual(s[key]["latest_from"], "transcript", key)
        self.assertEqual(s["rules_user"]["latest"], len(RULE.encode()) // 4)
        self.assertEqual(s["mcp_tools"]["latest"], len("mcp__abc__list_projects\nmcp__abc__generate_image".encode()) // 4)
        self.assertEqual(s["deferred_builtin"]["latest"], len(b"CronCreate") // 4)
        self.assertEqual(s["system_prompt"]["latest"], len("You are an agent.\n# Memory\nYou have memory.".encode()) // 4)

    def test_disk_column_follows_imports_skips_cold_rules_and_unsent_files(self) -> None:
        r = self.audit()
        s = self.src(r)
        agents_md = len("# Agentic\nClaude plans and reviews. Codex implements.\n".encode())
        self.assertEqual(s["claude_md_user"]["now"], (len(b"@~/agentic/AGENTS.md\n") + 1 + agents_md) // 4)
        proj_md = len("# proj\nSee @docs/map.md for the layout. Mail me at a@b.c\n".encode()) + 1 + len(b"src/ holds the code.\n")
        self.assertEqual(s["claude_md_project"]["now"], proj_md // 4)
        self.assertEqual(s["rules_project"]["now"], len((RULE + "- One extra project line here.\n").encode()) // 4, "the paths: rule must stay cold")
        # Skill listing is name + description of enabled sources only: no bodies, no disabled or hidden skills.
        self.assertEqual(r["counts"]["skills"], 3)  # plan, on:deploy, on:go
        self.assertLess(s["skills"]["now"], 100)
        self.assertEqual(r["counts"]["plugins"], ["on"])
        self.assertEqual(r["counts"]["agents"], 1)
        self.assertIsNone(s["system_prompt"]["now"])
        total_now = sum(x["now"] or 0 for x in r["sources"])
        self.assertLess(total_now, 300, "settings.json and skill bodies must not be counted")

    def test_duplicate_rule_is_flagged(self) -> None:
        d = self.audit()["duplicates"]
        self.assertEqual(len(d), 1)
        self.assertEqual({d[0]["a"], d[0]["b"]}, {str(self.cfg / "rules" / "token-budget.md"), str(self.proj / ".claude" / "rules" / "token-budget.md")})
        self.assertEqual(d[0]["why"], "same name, shared lines")
        self.assertGreater(d[0]["tokens"], 0)

    def test_without_transcripts_disk_only_and_no_remainder(self) -> None:
        for d in (self.cfg / "projects").iterdir():
            for f in d.rglob("*.jsonl"):
                f.unlink()
        r = self.audit()
        self.assertIsNone(r["measured"]["latest"])
        self.assertIsNone(r["remainder"])
        self.assertEqual(self.src(r)["skills"]["latest_from"], "disk")
        self.assertIn("no session transcripts for this project yet", self.run_audit().stdout)

    def test_token_count_api_when_a_key_is_set(self) -> None:
        seen = []

        class Fake(http.server.BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                seen.append((self.path, self.headers.get("x-api-key"), body["model"]))
                n = 5 + len(body["messages"][0]["content"].split())
                out = json.dumps({"input_tokens": n}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(out)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Fake)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            env = {**self.env, "ANTHROPIC_API_KEY": "test-key", "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{srv.server_port}"}
            r = self.audit(env=env)
            text = self.run_audit(env=env).stdout.split("Agents:")[0]
        finally:
            srv.shutdown()
            srv.server_close()
        self.assertEqual(r["counting"], "api")
        self.assertEqual(seen[0], ("/v1/messages/count_tokens", "test-key", "claude-opus-5-5"))
        self.assertEqual(self.src(r)["rules_user"]["latest"], len(RULE.split()))
        self.assertEqual(r["attributed"] + r["remainder"], r["measured"]["latest"])
        self.assertIn("counted with the token-count API", text)
        self.assertNotRegex(text, r"~\d")
        # --no-api never calls it.
        self.assertEqual(self.audit("--no-api", env=env)["counting"], "estimate")

    def test_text_output_puts_three_measured_numbers_first(self) -> None:
        out = self.run_audit().stdout.splitlines()
        self.assertTrue(out[0].startswith("Startup tokens"))
        self.assertRegex(out[1], r"^  latest\s+74,135  measured")
        self.assertRegex(out[2], r"^  median\s+71,002  measured")
        self.assertRegex(out[3], r"^  change\s+\+4,133  measured")
        text = "\n".join(out)
        self.assertIn("rest of system prompt and built-in tools", text)
        self.assertIn("Loaded twice", text)
        self.assertIn("settings.json", text)
        self.assertNotRegex(text, r"\btok\b")


if __name__ == "__main__":
    unittest.main(verbosity=1)
