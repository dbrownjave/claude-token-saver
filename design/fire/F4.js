/* F4: the shipped Effort-slider bursts, put on the wind. Bursts still fire at the head as Manhattan
   wavefronts with per-cell jitter and a five-step energy ramp; now their origin rides left with age and
   the distance metric is stretched so each front smears into a leftward tongue. A white-hot core sits on
   the head, and the charged bed carries the ink back to the left edge. */
;(() => {
  const REF = 3.5                    // distances are measured in desktop cells, so the terminal raster keeps the same look
  const FS = {
    WIND: 44,                        // units/s a burst origin rides left: about 3 desktop cells per 70 ms tick
    SLOT: 0.105, FIRE: 0.8,          // a burst slot every 1.5 ticks, 80% of them fire
    MAX_AGE: 0.95, AGE_COOL: 2.4,    // a tongue lives under a second and cools as it blows away
    SPEED: 16,                       // wavefront speed in units/s, slower than the wind so fronts lag behind their origin
    BACK: 0.4, FWD: 3, DY: 1.8,      // leftward distance is cheap (tongues stretch), forward is dear (nothing passes the head)
    RANGE: 22, JITTER: 0.06,
    HEAD_GAIN: 1.25, HEAD_DECAY: 6, BODY_GAIN: 0.6, BODY_DECAY: 2.2,
    DENSITY: 0.8, DASH: 4,           // dashes 4 units long, riding with their burst
    AMP_LO: 0.55, burstRamp: 2, fadeUp: 0.7,
    SPAN: 64,                        // flames only in the last 64 units before the head
    COOL_LEN: 48,                    // flames cool with distance from the head: white near it, c1 far off
    TAIL: 9, TAIL_BLOCK: 2.5,        // the heat that trails off the core, in wind-borne row blocks
    CORE: 1.6, CORE_FADE: 3.2,       // white-hot for 1.6 pitches behind the head, gone by 3.2
    BREATH_DIP: 0.22, BREATH_BASE: 0.5, BREATH_VARY: 0.4,
    BED_LO: 0.5, BED_HI: 0.82,       // the charged bed's alpha: left edge to head
    gain: 1.5,
  }
  const TRACK = [0.165, 0.165, 0.18]
  function hash21(x, y) {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return v - Math.floor(v)
  }
  const mixN = (a, b, t) => a + (b - a) * t
  const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)

  window.FIRE_OPTIONS.push({
    id: 'F4',
    name: 'Bursts on the wind',
    note: 'The shipped burst recipe with every wavefront origin riding left at about 3 cells a tick and a stretched distance metric, so each burst smears into cooling dashes behind a white core and a wind-broken heat tail, over a steady charged bed. Costs a slot-indexed schedule (about 9 bursts a frame whatever t is, which also drops the shipped 400-burst cap) and gives up the shipped left-quarter fade and the outward bursts; on amber the flames are low-contrast against the bright bed.',
    frame(bar, t) {
      const live = bar.live
      const headU = bar.head / REF, rowU = bar.H / bar.rows / REF
      const L = live ? Math.min(t / FS.fadeUp, 1) : 1
      const wind = FS.WIND * (bar.wind ?? 1)
      const bursts = []
      if (live) {
        // slot-indexed schedule: constant work however long the session has run
        const n1 = Math.floor(t / FS.SLOT), n0 = Math.floor((t - FS.MAX_AGE) / FS.SLOT)
        for (let n = Math.max(n0, 0); n <= n1; n++) {
          const s = bar.seed + n * 1.7
          if (hash21(s, 3.3) > FS.FIRE) continue
          const T = (n + 0.8 * hash21(s, 5.1)) * FS.SLOT, age = t - T
          if (age < 0 || age > FS.MAX_AGE) continue
          const ramp = 0.45 + 0.55 * Math.min(T / FS.burstRamp, 1)
          const k = Math.min((0.55 + 0.45 * bar.shown) * ramp, 1) * (0.8 + 0.4 * hash21(s, 7.7))
          bursts.push({
            age, k, salt: n * 0.37,
            ox: headU - 1.2 * hash21(s, 9.9) - wind * age,     // the origin rides the wind
            oy: (0.15 + 0.7 * hash21(s, 11.3)) * bar.H / REF,
            cool: Math.exp(-age * FS.AGE_COOL) * mixN(FS.AMP_LO, 1, k),
            range: FS.RANGE * mixN(0.6, 1, k),
          })
        }
      }
      return { live, headU, rowU, L, bursts, drift: -wind * t }
    },
    shade(cx, cy, bar, t, s) {
      const p = bar.pitch, px = (cx + 0.5) * p, head = bar.head
      const behind = (head - px) / p                       // pitches behind the head; negative is ahead
      if (behind < -0.5) {
        // a faint forward spark now and then, never past 2 pitches
        if (!s.live || behind < -2) return null
        const tick = Math.floor(t / 0.07)
        if (hash21(cx + tick * 0.13, cy + bar.seed) > 0.08) return null
        const w = 0.35 * (behind + 2) / 1.5
        return bar.ink.hot.map((c, i) => TRACK[i] + (mixN(1, c, 0.5) - TRACK[i]) * w)
      }
      const ink = bar.ink, seed = bar.seed
      const g = clamp01(px / Math.max(head, 1))
      const xU = px / REF, yU = (cy + 0.5) * s.rowU, dU = s.headU - xU

      // flames: the shipped wavefront, origin advected left, metric stretched left
      let energy = 0
      if (s.live && dU < FS.SPAN) {
        const jitter = (hash21(cx + 41.7 + seed, cy + 41.7 + seed) - 0.5) * 2 * FS.JITTER
        const vary = 0.6 + 0.4 * hash21(cx + 13.7 + seed, cy + 13.7 + seed)
        for (const b of s.bursts) {
          const dx = xU - b.ox
          const manh = (dx > 0 ? dx * FS.FWD : -dx * FS.BACK) + Math.abs(yU - b.oy) * FS.DY
          const tt = b.age - manh / FS.SPEED - jitter
          if (tt < 0) continue
          // density gates wind-stretched dashes, not single cells, so a burst reads as streaks
          const dash = Math.floor((xU - b.ox) / FS.DASH)
          if (hash21(dash + 7.3 + seed + b.salt, cy + 7.3 + seed + b.salt) > FS.DENSITY) continue
          const fall = Math.exp(-manh / b.range)
          energy += (FS.HEAD_GAIN * Math.exp(-tt * FS.HEAD_DECAY) + FS.BODY_GAIN * Math.exp(-tt * FS.BODY_DECAY)) * b.cool * fall * vary
        }
        energy *= FS.gain * Math.exp(-dU / FS.COOL_LEN)
        // the tail: heat peeling off the core, broken into row blocks that ride the wind
        const blk = Math.floor((dU + s.drift) / FS.TAIL_BLOCK)
        const gust = 0.55 + 0.6 * hash21(blk + seed, cy * 7.1 + 2.3)
        energy = Math.max(energy, Math.exp(-Math.max(dU - FS.CORE * p / REF, 0) / FS.TAIL) * gust) * s.L
      }
      // the white-hot core: full at the head, cooling over a couple of pitches
      let core = clamp01((FS.CORE_FADE - behind) / (FS.CORE_FADE - FS.CORE))
      if (!s.live) core *= 0.55 + 0.1 * Math.sin(t * 1.6 + cy)          // not live: a quiet ember, no wind
      else core *= s.L
      const e = Math.max(clamp01(energy), core)

      // five-step ramp, top step white, cooling through hot → c0 → c1
      const lv = (e > 0.06) + (e > 0.22) + (e > 0.42) + (e > 0.64) + (e > 0.86)
      let col = null, alpha = 0
      if (lv > 0) {
        const STEPS = [null, ink.c1, ink.c0, ink.hot, null, null]
        col = lv === 5 ? ink.hot.map((c) => mixN(c, 1, 0.9)) : lv === 4 ? ink.hot.map((c) => mixN(c, 1, 0.5)) : STEPS[lv]
        alpha = [0, 0.4, 0.6, 0.8, 0.92, 1][lv]
        if (lv === 5 && core < 0.86) {                                  // top-step flame cells breathe; the core holds
          const period = FS.BREATH_BASE + FS.BREATH_VARY * hash21(cx + 3.1 + seed, cy + 3.1 + seed)
          alpha *= 1 - FS.BREATH_DIP * 0.5 * (1 + Math.sin((t * 6.2832) / period + hash21(cx + 5.5 + seed, cy + 5.5 + seed) * 6.2832))
        }
      }
      // the charged bed: steady ink, deepening toward the head
      const bedA = mixN(FS.BED_LO, FS.BED_HI, g) * (s.live ? s.L : 1)
      const out = [0, 0, 0]
      for (let i = 0; i < 3; i++) {
        const bed = mixN(ink.c1[i], ink.c0[i], g)
        const under = TRACK[i] + (bed - TRACK[i]) * bedA
        out[i] = Math.min(1, col ? under + (col[i] - under) * alpha : under)
      }
      return out
    },
    glow(bar, t, s) {
      const hot = bar.ink.hot.map((c) => mixN(c, 1, 0.6))
      if (!s.live) return { x: bar.head - 4, y: bar.H / 2, rx: 14, ry: 8, rgb: bar.ink.hot, alpha: 0.12 }
      const flick = 0.85 + 0.15 * hash21(Math.floor(t / 0.07), bar.seed)
      return { x: bar.head - 8, y: bar.H / 2, rx: 30, ry: 11, rgb: hot, alpha: 0.32 * flick * s.L }
    },
  })
})()
