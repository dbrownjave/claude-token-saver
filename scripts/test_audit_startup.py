#!/usr/bin/env python3
"""Self-test for the SessionStart hook: the startup line is the measured one from this project's transcripts, says
"tokens", flags rules that load twice, stays under the hook's limit, and never calls the token-count API. Runs in a temp
config dir and a temp project; never touches ~/.claude.

    python3 -I scripts/test_audit_startup.py
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
HOOK = PACK / ".claude" / "hooks" / "audit_startup.py"
AUDIT = PACK / "scripts" / "token-audit.py"
RULE = "# Token budget\n- One task per session. Topic change means clear.\n- Prefer a short, cache-stable session.\n- Quiet flags on tests and git.\n"


def sanitize(p: Path) -> str:
    return re.sub(r"[^A-Za-z0-9]", "-", str(p))


def first_turn(ts: str, total: int) -> list[dict]:
    return [
        {"type": "user", "timestamp": ts, "message": {"role": "user", "content": "hi"}},
        {"type": "assistant", "timestamp": ts, "message": {"model": "claude-opus-5-5", "usage": {
            "input_tokens": 2, "cache_creation_input_tokens": total - 2, "cache_read_input_tokens": 0}}},
    ]


class StartupHook(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="audit-startup-test-")).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.cfg = self.tmp / ".claude"
        self.proj = self.tmp / "proj"
        (self.proj / ".claude" / "rules").mkdir(parents=True)
        (self.cfg / "rules").mkdir(parents=True)
        (self.proj / "CLAUDE.md").write_text("# proj\n", encoding="utf-8")
        self.tdir = self.cfg / "projects" / sanitize(self.proj)
        self.tdir.mkdir(parents=True)
        self.env = {k: v for k, v in os.environ.items() if k not in ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL")}
        self.env.update(CLAUDE_CONFIG_DIR=str(self.cfg), HOME=str(self.tmp), CLAUDE_PROJECT_DIR=str(self.proj))

    def sessions(self, *totals: int) -> None:
        for i, total in enumerate(totals):
            rows = first_turn(f"2026-10-1{i}T10:00:00Z", total)
            (self.tdir / f"s{i}.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")

    def run_hook(self, hook: Path = HOOK, env: dict | None = None) -> str:
        proc = subprocess.run([sys.executable, "-I", str(hook)], input=json.dumps({"source": "startup"}), cwd=self.proj,
                              env=env or self.env, capture_output=True, text=True, timeout=8, check=False)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertLessEqual(len(proc.stdout), 700)
        self.assertNotRegex(proc.stdout, r"\btok\b")
        return proc.stdout

    def test_measured_last_and_median(self) -> None:
        # Sorted by timestamp: the last session is the 2026-10-12 one, whatever the file order.
        self.sessions(70000, 74135, 74581)
        out = self.run_hook()
        self.assertIn("Startup (measured): last session 74,581 tokens, median 74,135 over 3 sessions.", out)
        self.assertNotIn("~", out)

    def test_one_session_has_no_median(self) -> None:
        self.sessions(74581)
        self.assertIn("Startup (measured): last session 74,581 tokens.", self.run_hook())

    def test_no_transcripts_prints_no_figure(self) -> None:
        out = self.run_hook()
        self.assertNotIn("Startup", out)
        self.assertTrue(out.startswith("Token budget active."))

    def test_rule_loaded_twice(self) -> None:
        (self.cfg / "rules" / "token-budget.md").write_text(RULE, encoding="utf-8")
        (self.proj / ".claude" / "rules" / "token-budget.md").write_text(RULE, encoding="utf-8")
        out = self.run_hook()
        self.assertIn("Loaded twice: ~/.claude/rules/token-budget.md + .claude/rules/token-budget.md. Keep one copy.", out)

    def test_installed_layout(self) -> None:
        # manage.py copies hooks/ and scripts/ side by side under ~/.claude/token-saver.
        inst = self.tmp / "token-saver"
        (inst / "hooks").mkdir(parents=True)
        (inst / "scripts").mkdir()
        shutil.copy2(HOOK, inst / "hooks" / HOOK.name)
        shutil.copy2(AUDIT, inst / "scripts" / AUDIT.name)
        self.sessions(74000, 75000)
        self.assertIn("last session 75,000 tokens, median 74,500 over 2 sessions", self.run_hook(inst / "hooks" / HOOK.name))

    def test_missing_audit_script_still_prints_budget(self) -> None:
        lone = self.tmp / "lone" / "hooks"
        lone.mkdir(parents=True)
        shutil.copy2(HOOK, lone / HOOK.name)
        self.sessions(74000)
        out = self.run_hook(lone / HOOK.name)
        self.assertTrue(out.startswith("Token budget active."))
        self.assertNotIn("Startup", out)

    def test_never_calls_token_count_api(self) -> None:
        hits: list[str] = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                hits.append(self.path)
                self.send_response(500)
                self.end_headers()

            def log_message(self, *a) -> None:
                pass

        server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        (self.cfg / "rules" / "token-budget.md").write_text(RULE, encoding="utf-8")
        (self.proj / ".claude" / "rules" / "token-budget.md").write_text(RULE, encoding="utf-8")
        self.sessions(74000, 75000)
        env = {**self.env, "ANTHROPIC_API_KEY": "test-key", "ANTHROPIC_BASE_URL": f"http://127.0.0.1:{server.server_port}"}
        out = self.run_hook(env=env)
        self.assertIn("Startup (measured)", out)
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main(verbosity=1)
