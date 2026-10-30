---
name: mod-authoring
description: How to change the token-saver mod (plugins/token-saver/hooks/register.js) safely. Use when editing the Context pane, the band, keep-warm, quiet-bash, the compact guard, a ui.render hook, or any $.* call; when a test fails; or when the user asks how Claude Code mods work.
---

# Editing the mod

The mod is one module, `plugins/token-saver/hooks/register.js`, plus `glossary.js`. The API reference for mods is `docs/claude-mods.md` in this repo (events, `$` nouns, elements, surfaces, testing, gotchas). Read the section you need; do not read the whole file.

## Before you edit

1. `rg -n "on\('<event>'" plugins/token-saver/hooks/register.js` to find the hook. One event, one `on(...)`: registering the same `ui.*` event twice fails the module load.
2. Read the smallest range around it. The file is 2,400 lines; never read it whole.
3. State that must survive a hot reload lives in `$.state` / `$.store`; module `let`s reset on every reload.

## Rules this repo has learned (each cost a bug)

- **Desktop collapses plain spaces** between Text pieces: wrap strings in `nbsp()`. The terminal does not.
- **Desktop theme colour names come out grey**: pass `ui.hex(key)`, the terminal keeps names. Every hex lives in `PALETTES` (dark, light) and is read as `PAL.X`; `usePal(term)` sets `PAL` after the render's last `await`, so never await between it and the tree. New colours go in both palettes.
- **Desktop redraws every 140 ms lose clicks**: the band redraws on the desktop only on news. A bar animates there by itself: a SMIL loop inside the Svg (`cellBar`'s `anim` for the fire, `glint` for a sweep), never by invalidating.
- **Pieces that may be squeezed get `wrap: 'truncate'`** (`one()` / `line()` in `drawContextPane`), or they wrap word by word.
- **Narrow** is `!term && (o.mobile || cells < 72)`: long rows split, cards go one per row, ⤢ is hidden. Mobile is `e.surface === 'mobile'`.
- **`$.session.compact` rejects on the desktop/SDK**: compact there is `$.prompt.submit({ text: '/compact' })`. Keep the fallback.
- **VS Code is `e.surface === 'vscode'`**: Svg like the desktop, never Raster or Client; it always places panes, so branch on `placesPanes(surface, isFullscreen)`, not on `isFullscreen` alone. `no-surface` (nothing attached) gets text, not a toast.
- **No `options` in `plugin.json` `userConfig`**: older CLIs (VS Code's bundled 2.1.263) refuse the whole plugin over it. Validate choices in `register()`.
- **Panes may not be placed**: check `opened.isPlaced !== false` and toast the reason; never a button that does nothing.
- **Numbers must be true.** The pane claims only what the plugin itself did (trimmed output, compactions vetoed, keep-warm net). Claude's own prompt cache is shown beside it and never added in. Any new figure needs: what it measures, the counterfactual it assumes, and a `≈` if estimated.
- No `bold` in the pane; colour carries hierarchy (`text`, `inactive`, `success`, threshold colour).

## Test, then release

```bash
cd plugins/token-saver && claude plugin test .
```

Quiet output: `| grep -E "\(fail\)|Expected|Received| pass$| fail$"`. Tests mount the pane with `$.ui.mount` and assert with `ui.find({ key | text })`; the mock harness cannot make `session.compact` reject with a custom error. Then use the `release` skill.
