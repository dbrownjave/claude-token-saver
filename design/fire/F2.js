/* F2: flame tongues. A wind-scrolled value-noise field times a heat envelope pinned to the head. */
;(() => {
  const FL = {
    LEN: 0.15,        // heat envelope length, as a share of bar width (≈35 cells on desktop) …
    LEN_MIN: 12,      // … but never under 12 cells, so the 2-row terminal raster still has room for wind
    WIND: 0.18,       // wind speed, bar widths per second (≈3 cells per 70 ms tick on desktop)
    TONGUE: 0.04,     // tongue length scale, bar widths: long and thin, stretched by the wind
    FINE: 0.8,        // second octave: this much shorter …
    FINE_RUSH: 1.1,   // … and a little faster (≈0.4 lattice cells a tick: motion, not twinkle), so tips tear off
    CHURN: 1.6,       // vertical churn, rows per second
    CORE: 2.2,        // cells behind the head that stay white, on the middle rows (edge rows get less: a rounded nose)
    ROOT: 8,          // cells behind the head where heat never drops below c0: the tongues grow out of the head
    STEPS: 5,         // quantize heat like the shipped five-step ramp: crisp tongues, not mush
    BED_LIFT: 0.72,   // bed = track → c1 at this mix; calm, no motion
    EMBER: 0.35,      // not live: envelope shrinks to this, breathes slowly
  }
  const WHITE = [1, 1, 1]
  const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

  function hash21(x, y) {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return v - Math.floor(v)
  }
  // Value noise on an integer lattice, smoothstep-blended. 0..1.
  function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy)
    const a = hash21(ix, iy), b = hash21(ix + 1, iy), c = hash21(ix, iy + 1), d = hash21(ix + 1, iy + 1)
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy
  }

  window.FIRE_OPTIONS.push({
    id: 'F2',
    name: 'Flame tongues',
    note: 'Two octaves of value noise scroll left with the wind (the finer one faster, so tips tear off), thresholded into tongues and gaps (solid at the head, breaking up further back) and multiplied by a heat envelope that is white at the head and reaches the bed about 35 cells back, quantized to five steps through white, hot, c0, c1 into a still bed. Two noise lookups per cell inside the envelope only; the pale blue hot ink makes blue tongues read nearly white. The wind is a scrolling texture, so nothing visibly tears off the head the way the comet (F1) embers do.',
    frame(bar, t) {
      const ink = bar.ink, live = bar.live
      const len = Math.max(FL.LEN * bar.W / bar.pitch, FL.LEN_MIN) * (live ? 1 : FL.EMBER)
      const tongue = FL.TONGUE * bar.W / bar.pitch
      const scroll = live ? FL.WIND * (bar.wind ?? 1) * bar.W / bar.pitch * t : 0
      // Ramp from bed (step 0) to white (top step). Two whites at the top so the head reads white-hot.
      const bed = mix3(bar.track, ink.c1, FL.BED_LIFT)
      const ramp = [bed, ink.c1, ink.c0, ink.hot, mix3(ink.hot, WHITE, 0.6), WHITE]
      // Not live: one slow, shallow breath instead of wind; the core never drops below hot ink (see shade).
      const breath = live ? 1 : 0.85 + 0.15 * Math.sin(t * 1.6)
      return {
        headCell: bar.head / bar.pitch, len, tongue, scroll, ramp, live, breath, core: bar.pitch > 6 ? 1 : FL.CORE,
        churn: live ? FL.CHURN * t : 0.15 * t, oy: bar.seed * 0.37, rowK: 2.2 / bar.rows,
      }
    },
    shade(cx, cy, bar, t, s) {
      const d = s.headCell - (cx + 0.5)          // cells behind the head (negative = ahead)
      if (d < -0.5) return null
      if (d > s.len) return s.ramp[0]
      // Linear-ish falloff with a soft shoulder: tongues still reach c1 near the far end of the envelope.
      const r = Math.max(d, 0) / s.len, e = r >= 1 ? 0 : (1 - r) * (1 - r * 0.2)
      // Wind frame: sampling at cx + scroll means a feature moves left as scroll grows.
      const X = cx + s.scroll, Y = cy * s.rowK + s.oy
      const n1 = vnoise(X / s.tongue, Y + s.churn * 0.5)
      const n2 = vnoise(X * FL.FINE_RUSH / (s.tongue * FL.FINE) + 17.3, Y * 1.7 - s.churn)
      // Sharpen into tongues and gaps. The cut rises with distance, so the field is nearly solid at the head
      // and only breaks into tongues further back: flames growing out of the head, not floating behind it.
      const lo = 0.10 + 0.40 * r
      let n = n1 * 0.65 + n2 * 0.35
      n = n < lo ? 0 : n > lo + 0.36 ? 1 : (n - lo) / 0.36
      // Middle rows burn a touch hotter: a pointed flame front, not a flat slab.
      const yc = (cy + 0.5) / bar.rows - 0.5
      let h = e * (0.08 + 1.1 * n) * (1 - 0.6 * yc * yc)
      if (d < FL.ROOT) h = Math.max(h, e * e * 0.75)
      if (d < s.core * (1.3 - 1.2 * yc * yc)) h = Math.max(h, 1.1 - 0.12 * Math.max(d, 0))
      h *= s.breath
      let lv = Math.max(0, Math.min(FL.STEPS, Math.floor(h * FL.STEPS)))
      if (!s.live && d < s.core) lv = Math.max(lv, 3)          // the ember stays hot enough to mark the fill's end
      return s.ramp[lv]
    },
    glow(bar, t, s) {
      // A soft white bloom on the head; a hashed flicker per tick so it breathes with the flames.
      const k = s.live ? 0.8 + 0.2 * hash21(Math.floor(t / 0.07), bar.seed) : 0.5 * s.breath
      return { x: bar.head - 0.5 * bar.pitch, y: bar.H / 2, rx: bar.pitch * 4, ry: bar.H * 0.6, rgb: WHITE, alpha: 0.35 * k }
    },
  })
})()
