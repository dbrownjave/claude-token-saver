---
description: Standing token-budget policy for every Claude Code session. Apply on all coding work.
---

# Token budget (always on)

Tokens compound. Every turn resends the whole session. Prefer a short, cache-stable session over a clever prompt.

## Session
- One task per session. Topic change → `/clear` (or `/rename` then `/clear`).
- Set model and effort once at the start. Do not switch mid-session (busts the prompt-cache prefix).
- Do not edit `CLAUDE.md` or `.claude/settings.json` mid-session.
- Before a break: `/compact` while the cache is still warm. After a long idle, start a new session instead of compacting a cold history.
- To drop last turns only: `/rewind`, not `/compact`.
- Prefer `@path/to/file` over a `Read` when the path is already known.

## Model
- Default: Sonnet.
- Haiku: search, logs, test output, first-pass review, multi-file exploration.
- Opus: architecture, subtle bugs, irreversible decisions.
- If a task needs 3+ file reads to investigate, spawn a subagent (Haiku/Explore). Return a short summary only. Do not dump raw file contents into the parent session.

## Commands
- Use quiet flags. Never dump raw logs or full JSON into context.
- Prefer: `git status -sb`, `git log --oneline -20`, `git diff --stat` then a targeted diff.
- Tests: shortest reporter (`-q`, `--reporter=dot`, `--tb=short`).
- If output is huge, summarize failures first. Do not re-run the full suite to "see it again."

## Files
- Do not read `node_modules`, `.git/objects`, lockfiles, build artifacts, or `.env`.
- Read the smallest range that answers the question (offset/limit), not the whole file.
- Keep project `CLAUDE.md` under 200 lines. Put workflows in skills, not in CLAUDE.md.

## Cache prefix
- Do not toggle MCP, plugins, effort, or fast mode mid-task. Tool definitions sit in the prefix.
- Search goes to a subagent, not `/model` Haiku. Each model has its own cache.
- A pile of images breaks the match from the dropped image on.
- `/clear` is free. `/compact` is cheap only while the cache is warm. After the TTL, compact reprocesses the whole history.

## Output
- Act when you have enough. Do not list options and wait.
- No preambles, no recap of these rules.
- Code and diffs first. Prose only when a decision needs it.
