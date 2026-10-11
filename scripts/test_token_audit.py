#!/usr/bin/env python3
"""Self-test for the audit's Subagents section. Runs in a temp config dir and a temp project; never touches ~/.claude.

    python3 -I scripts/test_token_audit.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
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
        self.base_env = {k: v for k, v in os.environ.items() if k not in ("FORCE_PROMPT_CACHING_5M", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", "ENABLE_PROMPT_CACHING_1H")}
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


if __name__ == "__main__":
    unittest.main(verbosity=1)
