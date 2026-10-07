---
name: repo-skills
description: Find, suggest and enable skills for the repo you are in. Use when the user asks which skills apply here, whether a skill exists for a library or task (GSAP, SwiftUI, Higgsfield, charts, design systems…), says a skill is missing or parked, wants to add or link a skill to this project, or when the task clearly matches a skill that is not loaded. Also use at the start of work in a repo whose session-start line mentions parked skills.
---

# Repo skills

Skills parked in `~/.claude/skills-parked` cost nothing until needed. This skill finds the ones that fit the current repo or task and enables them with one command. Nothing is moved by hand.

## Find the tool

Use the first path that exists:

```bash
python3 ~/.claude/token-saver/scripts/skills.py suggest --for "<task or library>"
```

```bash
python3 scripts/skills.py suggest --for "<task or library>"
```

Omit `--for` to match on repo signals alone (package.json deps, Package.swift, xcodeproj, pyproject, Cargo.toml, go.mod, html libraries). Add `--json` when you need to branch on the result.

## Act on the result

1. **Already active** → use it now with the Skill tool. Say nothing about parking.
2. **Parked match** → one line to the user: which skills fit, from which signal, cost per turn. Offer two options, default the first:
   - this repo only: `skills.py link <names>` (symlink into `.claude/skills`, machine-local)
   - everywhere: `skills.py unpark <names>`
   On yes, run it and say one line: loads after `/clear` or a restart. In a session with the mod, `/loadout link <names>` does the same with no model turn.
3. **No match** → say so in one line and continue the task without a skill. Do not list every skill. Do not invent one.

## Rules

- Never `mv`, `rm`, or hand-write symlinks for skills. The tool keeps a manifest so everything can be undone.
- Do not edit `CLAUDE.md` or settings mid-session for this.
- Do not read SKILL.md bodies to decide. The tool scores names and descriptions; that is enough.
- A newly linked skill is not callable until the next session. Say that once, then move on.
- If the user wants to trim instead: `skills.py status` shows unused skills, `skills.py pick` parks them.
