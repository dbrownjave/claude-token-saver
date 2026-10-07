#!/usr/bin/env python3
"""Self-test for the skills manager. Runs in a temp config dir; never touches ~/.claude.

    python3 scripts/test_skills.py
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
SCRIPT = PACK / "plugins" / "token-saver" / "scripts" / "skills.py"


def write_skill(root: Path, name: str, desc: str) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    (d / "SKILL.md").write_text(f"---\nname: {name}\ndescription: {desc}\n---\nbody\n")
    return d


class SkillsManager(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="skills-test-"))
        self.cfg = self.tmp / ".claude"
        self.skills = self.cfg / "skills"
        self.parked = self.cfg / "skills-parked"
        self.agents = self.tmp / ".agents" / "skills"
        self.proj = self.tmp / "proj"
        self.proj.mkdir(parents=True)
        write_skill(self.skills, "gsap-react", "GSAP for React, useGSAP hook")
        write_skill(self.skills, "plan", "Turn a brief into plan.md")
        write_skill(self.agents, "gsap-core", "GSAP core API: tweens and easing")
        (self.skills / "gsap-core").symlink_to(Path("..") / ".." / ".agents" / "skills" / "gsap-core")
        self.env = {**os.environ, "CLAUDE_CONFIG_DIR": str(self.cfg)}

    def run_skills(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(SCRIPT), "--no-usage", *args],
            capture_output=True, text=True, env=self.env, cwd=self.proj,
        )

    def names(self, root: Path) -> list[str]:
        return sorted(p.name for p in root.iterdir() if not p.name.startswith(".")) if root.is_dir() else []

    def test_park_group_keeps_symlink_resolving(self) -> None:
        r = self.run_skills("park", "@gsap")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.names(self.skills), ["plan"])
        self.assertEqual(self.names(self.parked), ["gsap-core", "gsap-react"])
        self.assertTrue((self.parked / "gsap-core" / "SKILL.md").is_file(), "moved symlink must still resolve")
        manifest = json.loads((self.parked / ".parked.json").read_text())
        self.assertTrue(manifest["gsap-core"]["is_link"])
        self.assertIn("Takes effect in your next session", r.stdout)

    def test_link_unlink_unpark_round_trip(self) -> None:
        self.run_skills("park", "gsap-*")
        r = self.run_skills("link", "gsap-react")
        self.assertEqual(r.returncode, 0, r.stderr)
        link = self.proj / ".claude" / "skills" / "gsap-react"
        self.assertTrue(link.is_symlink() and (link / "SKILL.md").is_file())
        self.assertIn("gsap-react", self.run_skills("status").stdout.split("Linked into")[1])
        self.run_skills("unlink", "gsap-react")
        self.assertFalse(link.exists())
        self.assertTrue((self.parked / "gsap-react").exists(), "unlink must not touch the parked skill")
        r = self.run_skills("unpark", "gsap-*")
        self.assertEqual(self.names(self.skills), ["gsap-core", "gsap-react", "plan"])
        self.assertEqual(json.loads((self.parked / ".parked.json").read_text()), {})

    def test_unknown_name_exits_nonzero_and_changes_nothing(self) -> None:
        r = self.run_skills("park", "nope")
        self.assertEqual(r.returncode, 1)
        self.assertIn("Unknown: nope", r.stdout)
        self.assertEqual(self.names(self.skills), ["gsap-core", "gsap-react", "plan"])

    def test_unlink_refuses_real_directory(self) -> None:
        real = self.proj / ".claude" / "skills" / "local-skill"
        write_skill(real.parent, "local-skill", "a real project skill")
        r = self.run_skills("unlink", "local-skill")
        self.assertEqual(r.returncode, 1)
        self.assertTrue((real / "SKILL.md").is_file())

    def test_suggest_matches_deps_and_ignores_weak_hints(self) -> None:
        self.run_skills("park", "gsap-*")
        write_skill(self.parked, "design-taste-frontend", "Anti-slop frontend design")
        (self.proj / "package.json").write_text(json.dumps({"dependencies": {"gsap": "^3", "react": "^19"}}))
        r = self.run_skills("suggest", "--json")
        self.assertEqual(r.returncode, 0, r.stderr)
        data = json.loads(r.stdout)
        strong = [m["name"] for m in data["parked_matches"]]
        self.assertEqual(strong, ["gsap-react", "gsap-core"], "ranked by score: gsap+react in the name beats gsap alone")
        self.assertEqual([m["name"] for m in data["maybe"]], ["design-taste-frontend"])
        self.assertEqual(data["link_command"], "skills.py link gsap-react gsap-core")
        brief = self.run_skills("suggest", "--brief").stdout
        self.assertIn("gsap-react, gsap-core", brief)
        self.assertNotIn("design-taste", brief)

    def test_suggest_brief_is_silent_without_match(self) -> None:
        self.run_skills("park", "gsap-*")
        r = self.run_skills("suggest", "--brief")
        self.assertEqual((r.returncode, r.stdout), (0, ""))

    def test_suggest_for_topic_prefers_active(self) -> None:
        r = self.run_skills("suggest", "--for", "plan the work", "--json")
        data = json.loads(r.stdout)
        self.assertEqual([m["name"] for m in data["active_matches"]], ["plan"])

    def test_pick_cancels_on_empty_input(self) -> None:
        r = subprocess.run([sys.executable, str(SCRIPT), "--no-usage", "pick"], input="\n",
                           capture_output=True, text=True, env=self.env, cwd=self.proj)
        self.assertIn("Nothing changed", r.stdout)
        self.assertEqual(self.names(self.skills), ["gsap-core", "gsap-react", "plan"])


if __name__ == "__main__":
    unittest.main(verbosity=1)
