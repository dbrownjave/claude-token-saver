#!/usr/bin/env python3
"""Sanity-check hooks without Claude Code."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HOOKS = ROOT / ".claude" / "hooks"


def run(script: str, payload: dict) -> tuple[int, str]:
    proc = subprocess.run(
        [sys.executable, str(HOOKS / script)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode, proc.stdout


def expect_cmd(stdin_cmd: str, want: str | None) -> None:
    code, out = run(
        "quiet_bash.py",
        {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {"command": stdin_cmd, "description": "t"}},
    )
    assert code == 0, out
    if want is None:
        assert not out.strip(), f"expected no rewrite for {stdin_cmd!r}, got {out}"
        return
    data = json.loads(out)
    got = data["hookSpecificOutput"]["updatedInput"]["command"]
    assert got == want, f"{stdin_cmd!r} → {got!r}, expected {want!r}"


def main() -> int:
    expect_cmd("git status", "git status -sb")
    expect_cmd("git log", "git log --oneline -20")
    expect_cmd("pytest", "pytest -q --tb=short")
    expect_cmd("npm test", "npm test -- --reporter=dot")
    expect_cmd("rm -rf /tmp/x", None)
    expect_cmd("git status | head", None)

    sl = ROOT / "scripts" / "statusline.py"
    warm = {
        "model": {"display_name": "Sonnet"},
        "prompt_cache": {"warm": True, "ttl": "1h", "hit_ratio": 0.98, "expires_at": 9999999999, "recache_tokens_if_cold": 461000},
        "context_window": {"used_percentage": 41},
    }
    proc = subprocess.run([sys.executable, str(sl)], input=json.dumps(warm), text=True, capture_output=True, check=False)
    assert proc.returncode == 0 and "cache" in proc.stdout and "98%" in proc.stdout, proc.stdout
    cold = {"prompt_cache": {"warm": False, "recache_tokens_if_cold": 461000}}
    proc = subprocess.run([sys.executable, str(sl)], input=json.dumps(cold), text=True, capture_output=True, check=False)
    assert proc.returncode == 0 and "COLD" in proc.stdout, proc.stdout

    big = "ok line of test output that should be trimmed when huge\n" * 200
    code, out = run(
        "trim_output.py",
        {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": {"stdout": big, "stderr": "", "interrupted": False, "isImage": False},
        },
    )
    assert code == 0, out
    data = json.loads(out)
    trimmed = data["hookSpecificOutput"]["updatedToolOutput"]["stdout"]
    assert "trimmed" in trimmed
    assert trimmed.startswith("ok")

    code, out = run(
        "trim_output.py",
        {
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_response": {"stdout": big, "stderr": "FAIL", "interrupted": False},
        },
    )
    assert code == 0 and not out.strip(), "must not trim failures"

    print("selftest ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
