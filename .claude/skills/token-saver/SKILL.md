---
name: token-saver
description: Audit and apply the team token-budget for Claude Code. Use when the user mentions tokens, usage limits, /context bloat, expensive sessions, CLAUDE.md size, MCP overhead, or asks to save Claude tokens.
---

# Token saver

Run the team audit, then apply the standing policy in `.claude/rules/token-budget.md`.

## Steps

1. Run the auditor from the project root (do not cat the script into context):

```bash
python3 .claude/../scripts/token-audit.py
```

If this pack lives at repo root:

```bash
python3 scripts/token-audit.py
```

1b. The audit's `Agents` block lists every agent file in `~/.claude/agents` and `.claude/agents` with how long its cache lasts, and names any `subagentPromptCacheTtl` / `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` / `FORCE_PROMPT_CACHING_5M` that sets every agent at once. An agent remembers what it read for 5 minutes; a step longer than that (a build, a test run) makes it re-read everything. `/tokens` shows which agents did and whether a 1-hour cache (`cacheTtl: 1h` under `experimental`) would come out ahead; `/tokens learn agents` explains it. Never recommend it while a subscription is on usage credits.

2. Read `/context` with the user if they are in an active session. Call out system tools, MCP, and CLAUDE.md first — those load every turn.

3. If CLAUDE.md is over ~200 lines or ~1k tokens:
   - Move workflows into skills.
   - Keep the root file as a project map only.
   - Do not edit CLAUDE.md mid-session. Propose the edit, then tell the user to `/clear` after it lands.

4. If unused MCP servers are listed, tell the user to disable them in `/mcp`. Do not add new MCP servers to "save tokens."

4b. Skills. Every entry in `~/.claude/skills` costs tokens on every turn (its name and description sit in the system prompt). If the skill listing is long, run the manager instead of moving folders by hand:

```bash
python3 scripts/skills.py
```

   - That prints active skills with per-turn cost, last use from local transcripts, and a `·` mark on skills unused for 30+ days.
   - To park, run `python3 scripts/skills.py pick` and let the user choose, or `python3 scripts/skills.py park unused` / `park gsap-*` when they have already said what to drop. In a session with the mod loaded, `/loadout park <names>` does the same without a model turn.
   - Never `mv`, `rm`, or hand-write symlinks for skills. The manager keeps a manifest so `unpark` and `link` can undo everything.
   - After any change say one line: takes effect after `/clear` or a restart; `skills.py unpark <name>` brings one back everywhere, `skills.py link <name>` for this repo only.

5. For the current task:
   - One task. Topic change → `/clear`.
   - `@file` instead of Read when the path is known.
   - 3+ files to investigate → Haiku/Explore subagent, return a summary only.
   - Quiet flags on tests and git. Do not paste raw logs.

6. Report three numbers only: startup estimate, biggest waste bucket, one change to make next.
