# Install the token saver and walk the user through it

You are installing this pack for the person who opened you. Do the work. Explain each step in one sentence before you run it. Stop and ask only where this file says to ask.

Do not enable both quiet-bash implementations. Do not run `bench --live` unless they agree to spend tokens. Do not edit their `CLAUDE.md` in this session. Do not toggle MCP servers mid-task. Do not overwrite `~/.claude/token-saver/thresholds.json` or `quiet.json` if they already exist.

## 1. Find the pack

The folder is the one that contains this file, `install.sh`, and `plugins/token-saver`. If they dropped a zip, unzip it and `cd` into `claude-token-saver`. Run `python3 --version`; if python3 is missing, stop and say so.

## 2. Run the one-shot

```bash
chmod +x install.sh && ./install.sh
```

It does everything and asks nothing: copies files, installs the mod when this Claude Code accepts it (otherwise the Python hooks take over and it says so), enables the recommended modules, and preflights their existing `settings.json`. Their hooks stay. Each overlap prints one `note` line saying how the two coexist or that ours was left off.

Read the summary back to them in two sentences: what is on, and any `note` lines in plain words. If the mod was skipped, quote the reason. Do not re-run with different flags to "fix" a note; notes are decisions, not errors.

To preview without writing: `./install.sh --dry-run`. To choose modules by hand: `./install.sh --pick`. To take it all out: `./install.sh --uninstall`.

Skills: never move folders under `~/.claude/skills` by hand. `python3 scripts/skills.py status` shows what costs tokens; `pick` parks with the user; `suggest` finds parked skills that fit a repo. Changes load in the next session.

## 3. If a session is already open

Tell them `/reload-plugins` picks up the mod, and `/clear` picks up rules, skills and hooks. Both are free.

## 4. Status line (terminal users only)

```bash
./install.sh --enable statusline
```

If the preflight note says they already have one, leave theirs.

## 5. Show them their two files

Open these and explain them. Do not rewrite them unless they ask.

- `~/.claude/token-saver/thresholds.json` — their marks. Default is 40% note, 60% handoff then `/clear`, 75% compact if warm and a new chat if cold. They can add levels. This does not compact for them.
- `~/.claude/token-saver/quiet.json` — command rewrites. They add company commands here. Pipes and `rm` are never rewritten.

## 6. Walk the UI

Tell them to open a new Claude Code session, then do these in order.

1. In VS Code, open the Claude panel (Spark icon). Point at the prompt box: the fill is the window, the clock is the cache. The clock goes red when the TTL dies or right after compact. A model switch does not reset it.
2. Run `/context`. That grid is the source of truth: system prompt, tools, memory, skills, messages, free space, autocompact buffer. If MCP is heavy, tell them to disable unused servers in `/mcp` at the start of a session, not in the middle of a task.
3. Run `/tokens`. Same hint as the terminal band. No model turn. The VS Code panel will not draw the band.
4. Run `./install.sh bench` from the pack. Free. It shows a rewrite and a trimmed log. Failures stay intact.
5. Run `./install.sh dash`. Free. Read versus write is request accounting, not a bill. The named miss cause is on `/usage`.

Ask before `./install.sh bench --live`. That spends tokens.

## 7. How they use it after today

- Same task, cache warm, past their compact mark: `/compact`.
- Task done, or cache cold: write a handoff (goal, decisions, files, next step), then `/clear`, then `@handoff.md` in the new session.
- Do not `/model` to Haiku mid-session. Search goes to a subagent.
- Do not enable the Python quiet-bash hook while the mod is on. The installer leaves it off and says so.

## 8. Done

Tell them what is on, what you skipped and why, and the one file to edit if they want different percents. Then stop.
