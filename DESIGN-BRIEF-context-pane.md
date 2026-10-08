# Design brief: the token-saver Context pane

You are designing a small dashboard that lives inside Claude Code (the CLI and the desktop app's Code tab), drawn by a plugin. It opens with `/tokens`, floats above the prompt or docks beside the transcript, and closes on Esc. Its job: show an engineer, at a glance, that the token-saver plugin is paying for itself, and what to do next. Design for clarity in under three seconds; the user already knows what context and cache mean.

## What you can draw with

The surface is a constrained layout engine, not HTML. Available elements: `Box` (flex row/column, gap, padding, width in cells or %, border, background), `Text` (hex colour, bold, dim, inverse, wrap/truncate), `Button` (label, single-letter hotkey, primary/secondary/plain), and on the desktop an inline `Svg` of a given width/height. In the terminal there is no Svg: bars are rows of block glyphs or a `Raster` of coloured half-block cells. Fonts and sizes are fixed by the host (one monospace size in the terminal; the desktop uses the app's UI font at one size). No images, no animation except re-rendering on a 70 ms tick.

Existing visual language you may reuse: a bar made of tiny rounded cells (3 px on a 4 px pitch, three rows at 14 px high) with a "burst" animation that sweeps from the fill head, and a pill at the head carrying a short label. The cells recolour by category when needed.

## The data (all live, all optional)

- Context: tokens used, window size, percent, and a breakdown by category: system prompt, system tools, MCP tools, memory files, skills, messages, free space, autocompact buffer; the auto-compact threshold if enabled.
- Cache: whether the prompt cache is warm or cold, minutes left of the TTL (5 or 60), hit rate of the last request.
- Session savings from the plugin: tokens served from cache (billed at a tenth of a fresh read), tokens trimmed from tool output and the turns they were kept out of, quiet command rewrites, cold compactions vetoed (and the re-cache each avoided), turns so far, a per-month total carried across sessions.
- Billing mode: API (dollars, at a user-set or bill-derived rate) or subscription (no dollars; worth expressed as a share of the five-hour rate-limit window, once the window has moved). Or unknown: tokens only.
- The user's own thresholds (default 40 / 60 / 75 %) with names (watch, handoff, compact), and which is next.
- Actions: Clear (runs /clear), Compact (runs /compact, refused when the cache is cold), Later (close).

## Hard rules

1. Savings first. The breakdown appears only where it leads to an action ("MCP tools 63k every turn → /mcp, disable unused"). Never a plain legend for its own sake.
2. Never show a dollar on a subscription. Never invent a price; label estimates as estimates and show the real spend beside them.
3. Every number that can be zero at session start must still read sensibly ("0 tok saved", not a blank).
4. Three states must work: collapsed (one row + bar), expanded, and "no response yet" (before the first reply, when the cache and totals are unknown).
5. Readable in the terminal at 80 columns and on the desktop at ~860 px. No wall of text: bold the number, dim the label, one idea per line.
6. Colour: one accent family for the context bar that shifts with the crossed threshold (calm → amber → orange → red); the cache bar warm vs cold; category colours only on the expanded split bar. Dark background. No rainbow legends.
7. Hotkeys c / k / l on the three buttons; the expand toggle on e.

## What we tried and rejected

A four-card copy of Claude Code's own context dialog (session / weekly / model / cache): too much, and the limits are already in `/context`. A monochrome stats sheet: nobody could find the number that mattered. Side-by-side columns sized in pixels: overlapped on the desktop.

## Deliverable

Two annotated layouts (collapsed, expanded) for the desktop and the terminal, at true widths, with the exact strings for every line in the three states above, and a one-paragraph rationale for what you put first and what you cut. If you change the information hierarchy, say what an engineer gains.
