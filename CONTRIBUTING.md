# Contributing

Thank you. Three rules, then the loop.

## Rules

1. **Numbers must be true.** The pane claims only what the plugin itself did. A new figure needs: what it measures, the counterfactual it assumes, a `≈` if estimated, and a test. Never add Claude's own behaviour (its prompt cache, its auto-compaction) to the plugin's credit.
2. **Nothing forced, everything undoable.** A module is off until the person turns it on. Every change to their machine has an undo path (`--uninstall`, `unpark`, `unlink`). Their `settings.json` is never reordered.
3. **Fail open.** If a hook throws, the tool still runs and the pane shows the error in red instead of drawing nothing.

## Loop

```bash
cd plugins/token-saver
claude plugin validate .
claude plugin test .          # quiet: | grep -E "\(fail\)| pass$| fail$"
```

One session, no install: `claude --plugin-dir ./plugins/token-saver`. The mod API is documented in [docs/claude-mods.md](docs/claude-mods.md); the repo's own hard-won rules (desktop collapses spaces, 140 ms redraws lose clicks, `$.session.compact` rejects on the desktop…) are in `.claude/skills/mod-authoring/SKILL.md` and load automatically when you open the repo in Claude Code.

Python side: `python3 scripts/selftest.py` and `python3 scripts/test_skills.py` (temp dirs, never touch `~/.claude`).

## Pull requests

- One change per PR, tests included, both version files bumped (`plugins/token-saver/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`).
- Commit messages say what changed for the person using it, not the code: "Context pane: cards stack one per row on a phone".
- If it touches the pane, a screenshot of terminal and desktop.
