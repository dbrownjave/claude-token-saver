/* F1: Comet. A white-hot core at the head; behind it a short flickering flame body, wind-blown tongues and a stream of embers, all travelling left fast and cooling white -> hot -> c0 -> c1 into a calm bed. */
(() => {
  /* Lengths are px on the desktop bar; U rescales them for other geometries (terminal raster ~1.1). */
  const FC = {
    CORE: 2.2,          // pitches behind the head that stay white
    NOSE: 1.5,          // pitches ahead of the head a faint nose may glow (terminal allows 2)
    ZONE: 175,          // px behind the head where any flame can live
    BODY_LEN: 17,       // px e-folding of the flame body
    TONGUE_LEN: 80,     // px e-folding of the wind-blown tongues
    WIND: 170,          // px/s the flame texture is carried left (about 3.4 cells per 70 ms tick)
    BODY_CELL: 7,       // px size of the body flicker noise
    TONGUE_CELL: 30,    // px size of the tongue noise
    EMBER_GAP: 0.018,   // s between ember births (about 55 per second)
    EMBER_V_LO: 150, EMBER_V_HI: 310,   // px/s
    EMBER_D_LO: 30, EMBER_D_HI: 165,    // px an ember travels before it is cold
    EMBER_SPREAD: 1.6,  // how fast embers fan out from the centre line, comet-tail style
    STREAK: 1.1,        // tail length, in ticks of travel: an ember lights the cells it just crossed
    TICK: 0.07,
    BED_LO: 0.55, BED_HI: 0.86,          // bed opacity over the track, left edge -> head
  }
  const WHITE = [1, 1, 1]

  function hash21(x, y) {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return v - Math.floor(v)
  }
  const mixN = (a, b, t) => a + (b - a) * t
  const mix3 = (a, b, t) => [mixN(a[0], b[0], t), mixN(a[1], b[1], t), mixN(a[2], b[2], t)]
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
  /* 1-D value noise along a row: smooth, cheap, and it can be slid left by adding time to u. */
  function vnoise(u, row) {
    const i = Math.floor(u), f = u - i, s = f * f * (3 - 2 * f)
    return mixN(hash21(i, row), hash21(i + 1, row), s)
  }

  /* The heat ramp: 0 is the bed (or track ahead), then c1, c0, hot, white. Four even steps. */
  function ramp(h, base, ink) {
    if (h <= 0) return base
    if (h >= 1) return WHITE
    const k = h * 4, i = Math.floor(k), f = k - i
    const stops = [base, ink.c1, ink.c0, ink.hot, WHITE]
    return mix3(stops[i], stops[i + 1], f)
  }

  window.FIRE_OPTIONS.push({
    id: 'F1',
    name: 'Comet',
    note: 'A 2-3 cell white core sits on the head; frame() rasterises a flickering body, wind-blown tongues and about 55 hashed embers a second with streak tails, all carried left at 150-310 px/s and cooling through the ink, into a heat buffer that shade() only looks up (0.07 ms a frame). The flames cover the last ~175 px before the head, so a bar under ~20% is mostly flame, the amber ink’s hot step sits close to white so its core reads less distinct, and the stream moves only ~1.5 cells a tick on the 8 px terminal raster.',

    frame(bar, t) {
      const { W, pitch, rows, cols, head, live, seed } = bar
      const U = Math.sqrt((W * pitch) / (826 * 3.5))
      const wind = Math.max(bar.wind ?? 1, 0.05)
      const hc = Math.max(0, Math.round(head / pitch - 0.5))
      const zone = FC.ZONE * U
      const lo = Math.max(0, Math.floor((head - zone) / pitch)), hi = Math.min(cols - 1, hc + 2)
      const n = hi - lo + 1
      const heat = new Float32Array(rows * n)
      const mid = (rows - 1) / 2
      /* Core pulse: a quick shimmer while live, a slow breath when not. */
      const pulse = live ? 0.93 + 0.07 * Math.sin(t * 23 + seed) * Math.sin(t * 9.7) : 0.5 + 0.08 * Math.sin(t * 2.1)
      const drift = live ? FC.WIND * U * wind * t : 0

      for (let cy = 0; cy < rows; cy++) {
        const off = Math.abs(cy - mid) / Math.max(mid, 1)   // 0 on the centre line, 1 on the edges
        const rowK = 1 - 0.35 * off                          // edge rows burn shorter: a pointed comet tail
        for (let cx = lo; cx <= hi; cx++) {
          const p = (cx + 0.5) * pitch, d = head - p
          let h
          if (d < -0.5 * pitch) {
            /* the nose: one faint cell ahead, so the head is not a hard wall */
            h = d >= -FC.NOSE * pitch ? (live ? 0.8 : 0.5) * pulse * (1 - 0.7 * off) : 0
          } else if (d <= FC.CORE * pitch) {
            /* the core: white while live, the outer front cells a touch cooler for a rounded nose */
            h = live ? (d < 0.3 * pitch ? 1 - 0.12 * off : 1) * pulse + 0.05 : 0.62 + pulse * 0.2
          } else {
            const du = d / U
            const u = (p + drift) / U
            const flick = vnoise(u / FC.BODY_CELL, cy * 7.3 + seed)
            const body = Math.exp(-(du - FC.CORE * pitch / U) / (FC.BODY_LEN * rowK)) * (live ? 0.62 + 0.5 * flick : 0.75)
            let tongue = 0
            if (live) {
              const tn = vnoise((u + 1.3 * drift / U) / FC.TONGUE_CELL, cy * 3.1 + seed * 0.37)
              const s = clamp01((tn - 0.48) / 0.3)
              tongue = s * s * Math.exp(-du / (FC.TONGUE_LEN * rowK)) * 1.2
            }
            h = Math.max(body, tongue)
          }
          heat[cy * n + (cx - lo)] = Math.min(h, 1)
        }
      }

      if (live) {
        /* Embers: slot i is born at i*GAP (+jitter) at the head with a hashed row, speed and reach. */
        const span = (FC.EMBER_D_HI / FC.EMBER_V_LO) / wind
        const iHi = Math.floor(t / FC.EMBER_GAP), iLo = Math.max(0, Math.floor((t - span) / FC.EMBER_GAP) - 1)
        for (let i = iLo; i <= iHi; i++) {
          const born = (i + 0.8 * hash21(i, seed + 1.7)) * FC.EMBER_GAP
          const age = t - born
          if (age < 0) continue
          const hv = hash21(i, seed + 5.3), hd = hash21(i, seed + 9.1), hy = hash21(i, seed + 13.9)
          const v = mixN(FC.EMBER_V_LO, FC.EMBER_V_HI, hv) * U * wind
          const reach = mixN(FC.EMBER_D_LO, FC.EMBER_D_HI, hd * hd) * U
          const life = reach / v
          if (age >= life) continue
          const k = age / life
          const x = head - FC.CORE * pitch - v * age
          if (x < 0) continue
          /* fan out from the centre line as it ages */
          const y0 = mid + (hy - 0.5) * rows * 0.7
          const y = Math.max(0, Math.min(rows - 1, mid + (y0 - mid) * (1 + FC.EMBER_SPREAD * k)))
          const cy = Math.round(y)
          const h0 = (0.85 + 0.3 * hash21(i, seed + 21.1)) * Math.pow(1 - k, 0.7)
          const tail = v * FC.TICK * FC.STREAK
          const c0 = Math.floor(x / pitch), c1 = Math.floor((x + tail) / pitch)
          for (let c = c0; c <= c1; c++) {
            if (c < lo || c > hi) continue
            const along = c1 > c0 ? (c - c0) / (c1 - c0) : 0
            const hh = h0 * (1 - 0.65 * along)
            const j = cy * n + (c - lo)
            if (hh > heat[j]) heat[j] = hh
          }
        }
      }

      return { lo, hi, n, heat }
    },

    shade(cx, cy, bar, t, s) {
      const { pitch, head, ink, track } = bar
      const p = (cx + 0.5) * pitch
      const inZone = cx >= s.lo && cx <= s.hi
      const h = inZone ? s.heat[cy * s.n + (cx - s.lo)] : 0
      if (p > head + 0.5 * pitch) {
        /* ahead of the fill: the track, or the faint nose */
        if (h <= 0) return null
        return ramp(h, track, ink)
      }
      /* the bed: calm, a little deeper toward the head, a faint static grain so it reads as cells */
      const g = Math.min(p / Math.max(head, 1), 1)
      const a = mixN(FC.BED_LO, FC.BED_HI, g) * (0.94 + 0.06 * hash21(cx, cy + bar.seed))
      const tone = mix3(ink.c1, ink.c0, 0.3 * g * g)
      const bed = mix3(track, tone, a)
      return ramp(h, bed, ink)
    },

    glow(bar, t, s) {
      const U = Math.sqrt((bar.W * bar.pitch) / (826 * 3.5))
      const live = bar.live
      const pulse = live ? 0.9 + 0.1 * Math.sin(t * 23 + bar.seed) * Math.sin(t * 9.7) : 0.85 + 0.15 * Math.sin(t * 2.1)
      return {
        x: bar.head - (live ? 12 : 4) * U,
        y: bar.H / 2,
        rx: (live ? 38 : 14) * U,
        ry: bar.H * (live ? 0.95 : 0.7),
        rgb: mix3(WHITE, bar.ink.hot, live ? 0.35 : 0.8),
        alpha: (live ? 0.34 : 0.14) * pulse,
      }
    },
  })
})()
