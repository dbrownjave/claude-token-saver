# Fire head for the context bar: option contract

The context bar in `../context-pane-canvas.html` is drawn by a *fire option*: one file per option, `F<n>.js`, that pushes an object onto `window.FIRE_OPTIONS`. The canvas loads every option. Section 0 ("The context bar, up close") lets you compare them and pick one, and the pick redraws every context bar on the canvas.

The brief: no knob. The end of the fill is a white-hot glow, like something burning that is moving right fast, with its flames blown left by the wind.

## Shape

```js
window.FIRE_OPTIONS.push({
  id: 'F1',                       // F + digit, unique
  name: 'Comet',                  // a few words
  note: 'how it works, what it costs, what it breaks',   // one or two sentences
  frame(bar, t) { return state }, // optional: once per bar per frame, before any shade(); precompute here
  shade(cx, cy, bar, t, state) { return [r, g, b] | null },   // one cell, 0..1 rgb; null shows the track
  glow(bar, t, state) { return { x, y, rx, ry, rgb, alpha } | null },  // optional, see below
})
```

`bar` (read-only):

| field | meaning |
|---|---|
| `W`, `H` | bar size in px (desktop 826 × 14; terminal raster 440 × 16) |
| `rows`, `cols`, `pitch` | cell grid: desktop 4 rows, pitch 3.5 px; terminal raster 2 rows, pitch 8 px |
| `shown` | fill fraction, 0.02..1 |
| `head` | `shown * W`, the px position of the fill head. The cell whose centre `(cx + .5) * pitch` is nearest is the head cell |
| `ink` | `{ hot, c0, c1 }` rgb 0..1 for the crossed threshold: blue (calm), waiting (amber), orange, failed (red) |
| `inkName` | `'blue' \| 'waiting' \| 'orange' \| 'failed'` |
| `seed` | integer per bar, for per-bar variation |
| `track` | `[0.165, 0.165, 0.18]`, the empty track colour (blend toward it, never darker) |
| `live` | `true` while a session is running; `false` before the first reply. Not live means calm: no wind, a quiet ember |
| `wind` | speed multiplier from the page's slider. May be `undefined` (register.js has no slider): read it as `bar.wind ?? 1` |
| `lib` | the shipped shader from register.js (`shadeCell`, `burstsAt`, `rowSeed`, `INKS`, `SH`) or `null`. Do not depend on it |

`t` is in seconds. The host re-renders on a **70 ms tick** (about 14 fps), so `t` advances in steps of 0.07. Design motion that reads at 14 fps. The page has a "smooth" toggle for comparison, but the shipped mod cannot use it.

## Rules

1. **Pure.** Every frame is a function of `(cx, cy, bar, t)` alone. No `Math.random`, `Date`, `performance`, DOM or timers. Use a hash (e.g. `fract(sin(x * 127.1 + y * 311.7) * 43758.5453)`) for randomness. This is the rule the mod already follows, so the option can move into `register.js` unchanged.
2. **The fill still reads as progress.** From the left edge to the head, the bar must read as filled in the threshold ink. The flames live in the last stretch before the head. Further left is a calm bed in the ink, not white and not the track.
3. **The head is white-hot.** The cells at the head are near white. The heat cools leftward through `ink.hot → c0 → c1`, then into the bed.
4. **Wind blows left.** Flame features travel left, away from the head, fast (about 1 to 6 cells per tick, i.e. 50–300 px/s on desktop) and flicker. The head itself does not move unless `shown` changes.
5. **Nothing ahead.** Cells more than 3 pitches right of the head return `null` (a faint forward spark is allowed within 3 pitches).
6. **Cells first.** The terminal has no glow, only the cell colours in a 2-row half-block raster, so the effect must work from `shade()` alone. `glow()` is a desktop extra drawn as one additive radial gradient (it must be expressible as an SVG `radialGradient`): centre `x, y` in bar px, radii `rx, ry`, `rgb` 0..1, `alpha` 0..1.
7. **Cheap.** `frame()` plus `shade()` for every cell of an 826 px bar must average ≤ 2 ms in Node.

## Check

```bash
node design/fire/check.mjs design/fire/F1.js --ascii --png /tmp/F1.png
```

This prints pass/fail for every rule above, with the measured values: head whiteness, leftward drift in cells per tick, fill readability, ink saturation, cost. `--ascii` prints three consecutive ticks around the head. `--png` writes a contact sheet (eight consecutive ticks magnified ×4, the four inks, the whole bar, the terminal raster) that you can open to look at.
