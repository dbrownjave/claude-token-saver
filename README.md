# Claude Code token saver — individual install

Each engineer installs this on their own machine and turns on only the modules they want.

Nothing is forced. A bare install copies files and enables **zero** modules.

## Install (once per machine)

```bash
unzip claude-token-saver.zip
cd claude-token-saver
./install.sh
```

That is the whole install. No questions. It:

1. Copies the pack to `~/.claude/token-saver/`.
2. Installs the in-process mod through `claude plugin install` when your Claude Code accepts it. The marketplace is registered from a staged copy under `~/.claude/token-saver/pack`, so you can delete the download afterwards. If the build refuses the mod, the Python hooks cover the same ground and it says so.
3. Enables the recommended modules: rules, the two skills, the session-start line, the quiet map. The Python quiet-bash and trim hooks come on only when the mod is not.
4. **Preflights your existing `settings.json`.** Hooks you already have stay. For each one that overlaps, it prints one line saying how the two coexist, or that it left ours off (for example when you already have a status line). Nothing of yours is edited or reordered.
5. Prints a summary and the one thing left to do: open a new session.

While it works, an ASCII gold coin spins above the step list, a progress bar with a tick per step and a pill naming the current step fills underneath it, and each step ticks as it lands. It is a lit, textured disc in the spirit of David Haubner's ASCII Bitcoin animation, without the B; `--size` sets its height and `--emblem T` puts a raised letter on the face. On a pipe, in CI, or with `--plain` (or `TOKEN_SAVER_PLAIN=1`) you get plain lines instead. `NO_COLOR` is honored. `python3 scripts/coin.py --demo` shows it without installing anything.

Run it again after updating the pack; it restages the mod and Claude picks it up on the next session or `/reload-plugins`. `./install.sh --dry-run` shows the plan without writing. `./install.sh --pick` is the module picker if you want to choose. `./install.sh --uninstall` removes the mod, our hooks, rules and skills, and leaves everything else.

Requires `python3` (stdlib only). On Windows there is no bash; run the same one-shot directly:

```bash
python manage.py setup
```

Build the zip you hand to others with `scripts/dist.sh`. It runs the self-test, validates the mod, and writes `dist/claude-token-saver-<version>.zip` from a whitelist.

Other entry points:

```bash
./install.sh --list
./install.sh --enable cache-guard
./install.sh --disable trim-output
./install.sh --project --enable rules,quiet-bash    # one repo only
python3 manage.py status
```

## Mod

Mods are in-process plugins. They can rewrite a tool call and draw UI. Settings hooks cannot. `./install.sh` installs it for you; these are the manual equivalents:

```bash
claude plugin marketplace add .
claude plugin install token-saver@token-saver
# session already open:
# /reload-plugins
```

Or one session, no marketplace:

```bash
claude --plugin-dir ./plugins/token-saver
```

Toggles live on the plugin, not in a settings splice: `quietBash`, `trimOutput`, `cacheBand`, `compactHint`, `compactGuard`, `longCacheTtl`. They show up as rows in `/config`. Disable the whole thing with `/plugin disable token-saver@token-saver`.

### Progress bars (mod only)

The mod registers a `progress` tool. When Claude runs a job with stages, it calls the tool as each stage starts, waits, fails or ends, and a bar appears above the prompt.

The bar is a port of the Effort slider's own shader from the Claude app: a 14 px squared track of tiny rounded cells in three rows, lit by bursts that race out from the head every 0.3–0.75 s as Manhattan-distance wavefronts, a five-step white→ink ramp with breathing top cells, and a charged bed that deepens toward the head and fades over the first quarter. Tuned brighter than the slider. The stage and count ride in a gradient pill in the bar's own colour, trailing the head; there is no status icon, the colour and the pill's ✕ / ? / ✓ carry state. Purple running, amber waiting, red failed, green done. A finished row keeps sparking faintly for a minute, then holds still. Frames are a pure function of the band's 70 ms tick, so they are deterministic and testable.

In the terminal the same cells draw as a one-row Raster of half-block squares with a coloured text pill; where Raster is missing, small-square glyphs. × removes a row; `remove: true` from the tool does the same. `/loadout` actions use the same rows: one stage per skill, green when done, gone eight seconds later. The status line reads "Progress" while any bar is up.

### Compaction guard (mod only)

A settings hook can only add a note before `/compact`. The mod sits on the compaction itself:

| Trigger | What happens |
|---|---|
| `/compact`, cache warm | Runs. The keep-list (task, files touched, decisions, failing tests, next steps, exact errors) is appended to the summarizer's instructions. |
| `/compact`, cache cold | **Refused.** One line names the idle time and the tokens a compaction would re-send, and points at `/handoff` then `/clear`. |
| `/compact force` | Runs anyway. Keep-list still appended. |
| auto-compaction | Never refused. Keep-list appended. Blocking it would let the window overflow. |
| subagent transcripts | Left alone. |

"Cold" means idle longer than the prompt-cache TTL since the last response. Default TTL is 5 minutes; turn on `longCacheTtl` if your sessions get the 1-hour cache. `/tokens` shows which state you are in.

Dev loop: `claude plugin validate ./plugins/token-saver` then `claude plugin test ./plugins/token-saver`.

| What | Where it works |
|---|---|
| Quiet bash + trim | CLI, Desktop, VS Code panel, `claude -p` |
| Cache band above the prompt | CLI and Desktop only. VS Code does not draw mod UI; use its cache clock. |
| `/tokens` | Instant. No model turn. Context fill comes from the engine, not a hardcoded 200k window. `/tokens hide` and `show` toggle the band; the band also has a Hide button. |
| Threshold toast | Once per threshold crossed (40, 60, 75 percent by default), with the cache-aware hint. |
| First-run welcome | One toast the first time the mod loads on a machine, saying what is now on. |
| Compaction guard | Everywhere the mod loads. |
| `/loadout` | Opens a pane: every skill with cost per turn and last use, a Park button on each active one, Link here / Unpark on each parked one, Park N unused in the header. Esc closes. `/loadout list` is the text form. CLI and Desktop; the VS Code panel gets the text. |

Same `~/.claude/token-saver/quiet.json` as the Python hook. Do not run both quiet-bash implementations at once or commands get rewritten twice.

The mod does not touch the system prompt every turn. That would bust the cache. The band hint does not type a command into the box. Your marks live in `~/.claude/token-saver/thresholds.json`, copied once and never overwritten. Defaults: 40% note, 60% `/handoff` then `/clear`, 75% `/compact` if warm and a new chat if cold. `/context` in VS Code stays the category grid. The panel will not draw this band. `/tokens` prints the same hint. Enabling the Python `quiet-bash` hook while the mod is on is refused. `dash` shows cache read vs cache write per session. That is request accounting, not a bill. The named miss cause stays on `/usage`.

Python `dash` / `bench` stay. Mods do not read history.

## What we shipped next

```bash
./install.sh --enable statusline,quiet-map
```

| Module | What it does |
|---|---|
| `statusline` | CLI status bar: `● cache 98% 1h 12m  ctx 41%` or `▲ COLD  +461k if you type`. Does **not** overwrite an existing `statusLine`. VS Code’s chat panel already has a cache clock — this is for the terminal. |
| `quiet-map` | Copies `~/.claude/token-saver/quiet.json` if you do not already have one. Edit it to add `pnpm`, `kubectl`, company wrappers. Never overwritten on reinstall. |

`dash` now ranks the noisiest Bash commands from your last week of transcripts (count, est. tokens, whether a quiet.json rule already covers them).

Add your own rewrite:

```json
{
  "id": "kubectl-get",
  "pattern": "^kubectl\\s+get\\b",
  "unless": ["-o name"],
  "append": " -o name",
  "enabled": true
}
```

## Skills: park what you do not use

Every skill under `~/.claude/skills` costs tokens on **every turn**: its name and description sit in the system prompt's skill listing. The body only loads when you invoke it. Thirty skills is a few hundred tokens a turn, forever.

```bash
./install.sh skills             # active skills, tok/turn, last use, · = unused 30+ days
./install.sh skills pick        # interactive: choose what to park
./install.sh skills park gsap-* # by name, glob, @group, or 'unused'
```

In a session with the mod: `/loadout` opens the pane; `/loadout gsap-*` parks; `/loadout back gsap-react` brings one back everywhere; `/loadout link gsap-react` for this repo only. Instant, no model turn. The picker needs a TTY so it stays in the terminal.

| Action | What happens | Undo |
|---|---|---|
| `park` | Moves the skill (or its symlink) to `~/.claude/skills-parked/` and records where it came from in `.parked.json`. | `unpark` |
| `unpark` | Moves it back to its original place. | `park` |
| `link` | Symlinks a parked skill into this repo's `.claude/skills/`. Loads only when you work here. | `unlink` |
| `unlink` | Removes that symlink only. The skill stays parked. | `link` |

Nothing is ever deleted. Changes take effect in the next session (`/clear` or restart). "Last use" comes from a ripgrep over your local transcripts for Skill calls, run through the `claude` binary (BSD grep takes 30s on a big transcript dir) and cached for an hour (`--rescan` to refresh). It is a hint, not a bill. Parked skills that still get used are called out so you can `link` them where they belong. Links are machine-local: add `.claude/skills/<name>` to `.gitignore` if teammates do not have the parked skill.

The `/token-saver` skill routes skill bloat here and is told never to move skill folders by hand.

### Let Claude pick skills for the repo

You should not have to run an installer per session. Three things close the loop:

| Where | What | Cost |
|---|---|---|
| Session start (mod) | Reads the repo's manifests, names parked skills that fit, shows one toast and a log line. | 0 tokens |
| Session start (Python `session-audit` hook) | Same one line, appended to the budget line so **Claude** knows too. | ~30 tokens, only when there is a match |
| `/repo-skills` skill | When you ask "do we have a skill for X" or start GSAP/SwiftUI/Higgsfield work, Claude runs `skills.py suggest --for "X"`, tells you what fits, and links it on a yes. | loads on demand |

```bash
./install.sh skills suggest                     # parked skills that fit this repo
./install.sh skills suggest --for "scroll animation"
```

Signals: `package.json` deps, `tsconfig.json`, `Package.swift`, `*.xcodeproj`, `*.swift`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `Gemfile`, `Podfile`, Tailwind configs, and libraries referenced from an `index.html`. Dependency names and file types are strong signals. Aliases (`next`→react, `three`→3d, `gsap`→animation) and broad words (javascript, frontend) are weak hints: they can nudge a ranking but never put a skill in the link command. Matching is on skill names and descriptions, not bodies. Already-active matches are listed first so Claude uses what is loaded.

The session-start toast shows once a day per repo; the log line shows every time. Needs `python3` or `python` on PATH.

Self-test (temp dir, never touches `~/.claude`):

```bash
python3 scripts/test_skills.py
```

## Dashboard and bench

```bash
./install.sh dash                 # free — tokens from your local Claude Code sessions
./install.sh dash --watch         # refresh every 2s
./install.sh bench                # free — hook compression: used / saved / result preview
./install.sh bench --live         # A/B against Claude (asks first; spends tokens)
```

Same via Python:

```bash
python3 scripts/tui.py dash
python3 scripts/tui.py bench
python3 scripts/tui.py bench --live --prompt "git status then name the 3 newest files"
```

| Command | Calls Claude? | What “saved” means |
|---|---|---|
| `dash` | no | Real tokens your past sessions used. Does **not** invent a savings %. |
| `bench` | no | Tokens the hooks strip from command output (used vs after). Shows the trimmed result. |
| `bench --live` | yes, twice | OFF arm vs ON arm. Shows tokens, $, and both result texts so you can judge quality. |

Live A/B is capped at 4 turns and $0.50 per arm. Tools are read-only plus Bash. Confirm before it spends.

## Where it lives

| | Path | Scope |
|---|---|---|
| Files | `~/.claude/token-saver/` | You, all repos |
| Hooks spliced into | `~/.claude/settings.json` | You, all repos |
| Rules (if enabled) | `~/.claude/rules/token-budget.md` | You, all repos |
| Skill (if enabled) | `~/.claude/skills/token-saver/` | You, all repos |
| State | `~/.claude/token-saver/enabled.json` | What you turned on |

Your existing hooks stay. We only add or remove entries whose command path contains `token-saver/`. A timestamped backup of `settings.json` is written before each change.

Claude Code on the web / cloud VMs does **not** see `~/.claude`. This pack is for the local CLI/desktop app.

## One repo only (does not touch teammates)

```bash
./install.sh --project --enable rules,quiet-bash
```

Writes hooks into `.claude/settings.local.json` (gitignored) and files into `.claude/token-saver/`.

## Modules

Recommended (on if you press Enter):

| id | What it does |
|---|---|
| `rules` | Standing policy: `/clear` on topic change, `@file`, Haiku subagents |
| `skill` | `/token-saver` — loads only when you ask about tokens |
| `session-audit` | Short budget line at session start |
| `quiet-bash` | Rewrites `git status` / `git log` / tests to short output |
| `trim-output` | Caps huge *successful* bash stdout (never trims failures) |

Opt-in (off until you enable them):

| id | What it does |
|---|---|
| `compact-keep` | Keep-list injected before `/compact` |
| `cache-guard` | Asks before a mid-session model switch when the cache is warm |
| `slim-startup` | Caps bash at 8k chars; sets `CLAUDE_CODE_DISABLE_ARTIFACT=1` (reversible) |
| `deny-secrets` | Blocks Read on `.env`, `secrets/`, `node_modules` |
| `thinking-cap` | `MAX_THINKING_TOKENS=8000` |
| `no-connectors` | Disables claude.ai connectors (only if you do not use Slack/Jira/etc) |
| `no-remote` | Disables remote-control tool defs |

`slim-startup` does **not** write `enableArtifact: false`. That key can turn Artifacts off in a way you cannot turn back on from another file. The env var is reversible: disable the module and it is removed.

## Company use without mandating it

IT can put the zip on an internal drive and say:

> Install it yourself. Recommended: `./install.sh --enable rules,skill,quiet-bash,session-audit`

Each engineer still chooses. Nobody’s repo settings change unless they pass `--project`.

## After enable

Open a **new** Claude Code session and run `/context`. That is the before/after measurement.

```
/token-saver      if you enabled the skill
/mcp              disable unused servers (biggest startup win after Artifacts)
/clear            new task
/compact          only while the cache is warm
```

## Honest limits

- `trim-output` depends on `updatedToolOutput`, which has been flaky on some 2.1.x builds. `quiet-bash` is the reliable layer.
- Hooks fail open. If a script throws, the tool still runs.
- This cannot shrink Anthropic’s bundled system prompt.
- Uninstall removes **our** hooks, rules, skill, and owned settings keys. Everything else in `settings.json` stays.
