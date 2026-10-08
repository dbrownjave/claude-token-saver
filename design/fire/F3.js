/* F3: Afterburner. A white-hot nozzle at the head; behind it the exhaust streams left in per-row
   striations (each row at its own speed, so the rows shear) with shock diamonds riding the stream.
   Temperature is a scalar per cell, mapped through one ramp: white -> hot -> c0 -> c1 -> bed. */
(() => {
  const AB = {
    TICK: 0.07,
    SPEED: 3.2,          // exhaust speed, pitches per tick at wind 1 (about 160 px/s on desktop)
    SPEED_MAX_W: 0.04,   // ...capped to this share of the bar per tick, so the terminal's fat cells stay readable
    SHEAR: 0.5,          // spread of per-row speeds: rows at 0.75x..1.25x
    PLUME: 16,           // plume e-fold, pitches
    PLUME_MAX_W: 0.12,   // ...capped to this share of the bar width (terminal)
    PLUME_MAX_HEAD: 0.35,// ...and of the fill, so a short fill keeps some bed
    NARROW: 0.55,        // outer rows cool this much sooner: the plume tapers
    LICK: 0.3,           // per-row, per-tick plume length flicker
    NOZZLE: 2.2,         // white core length, pitches
    STREAK: 6,           // striation lattice, pitches: long thin streaks
    DIAMOND_GAP: 9,      // shock diamond spacing, pitches
    DIAMOND_JIT: 2.5,    // ...jittered, so the bands never alias into a backward crawl
    DIAMOND_W: 1.4,      // band half-width at the centre rows, pitches
    DIAMOND_REACH: 1.6,  // diamonds outlive the plume by this factor: the bright bands carry the motion out
    BED: 0.62,           // bed = track mixed this far toward c1
  }
  const WHITE = [1, 1, 1]
  const LUT_N = 64

  function hash21(x, y) {
    const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
    return v - Math.floor(v)
  }
  const mix3 = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
  const clamp01 = (x) => x < 0 ? 0 : x > 1 ? 1 : x

  /* temperature 0..1 to colour, one ramp per frame so shade() is a table lookup */
  function rampLut(ink, bed) {
    const stops = [[0, bed], [0.25, ink.c1], [0.5, ink.c0], [0.72, ink.hot], [0.92, mix3(WHITE, ink.hot, 0.08)], [1, WHITE]]
    const lut = []
    for (let i = 0; i < LUT_N; i++) {
      const T = i / (LUT_N - 1)
      let j = 1
      while (j < stops.length - 1 && T > stops[j][0]) j++
      const [t0, a] = stops[j - 1], [t1, b] = stops[j]
      lut.push(mix3(a, b, clamp01((T - t0) / (t1 - t0))).map(clamp01))
    }
    return lut
  }

  window.FIRE_OPTIONS.push({
    id: 'F3',
    name: 'Afterburner',
    note: 'A white nozzle at the head and an exhaust plume of per-row value-noise streaks plus jittered shock diamonds, all advected left at about 3 cells a tick with each row at its own speed, then one temperature ramp white -> hot -> c0 -> c1 -> bed. It reads fast and mechanical rather than flame-like, and with only two rows the terminal loses the diamond shape and keeps just bright bands.',
    frame(bar, t) {
      const { pitch, rows, head, W, ink, track, live, seed } = bar
      const n = t / AB.TICK
      const tick = Math.floor(n)
      const wind = live ? (bar.wind ?? 1) : 0
      const V = Math.min(AB.SPEED * pitch, AB.SPEED_MAX_W * W) * wind
      const L = Math.max(pitch * 2, Math.min(AB.PLUME * pitch, AB.PLUME_MAX_W * W, AB.PLUME_MAX_HEAD * head)) * (live ? 1 : 0.55)
      const rowK = []
      for (let cy = 0; cy < rows; cy++) {
        const rn = ((cy + 0.5) / rows) * 2 - 1
        const sp = 1 + AB.SHEAR * (hash21(seed + cy * 3.1, 1.7) - 0.5)
        const lick = live ? 1 + AB.LICK * (hash21(seed + cy * 5.3, tick * 0.37 + 2.9) - 0.5) : 1
        rowK.push({
          rn: Math.abs(rn),
          off: V * n * sp + 97 * hash21(seed + cy, 4.4),            // this row's stream position
          invL: 1 / (L * (1 - AB.NARROW * Math.abs(rn)) * lick),
          salt: seed * 0.13 + cy * 17.7,
        })
      }
      /* shock diamonds: band k sits at stream coordinate k*gap + jitter; keep only those in reach */
      const gap = AB.DIAMOND_GAP * pitch, wNow = V * n, reach = L * AB.DIAMOND_REACH * 2.2
      const bands = []
      if (live) {
        const k0 = Math.floor((-wNow - gap) / gap), k1 = Math.ceil((reach - wNow + gap) / gap)
        for (let k = k0; k <= k1; k++) {
          const at = k * gap + AB.DIAMOND_JIT * pitch * (hash21(seed + k * 1.3, 8.1) - 0.5) + wNow
          const pulse = 0.65 + 0.35 * hash21(k * 2.7 + seed, tick * 0.51)   // each band throbs tick to tick
          bands.push({ at, pulse })
        }
      }
      const bed = mix3(track, ink.c1, AB.BED)
      return {
        live, L, rowK, bands, bed,
        lut: rampLut(ink, bed),
        nozzle: AB.NOZZLE * pitch,
        dReach: 1 / (L * AB.DIAMOND_REACH),
        dW: AB.DIAMOND_W * pitch,
        lat: AB.STREAK * pitch,
        breath: live ? 1 : 0.9 + 0.1 * Math.sin(t * 1.6),
        spark: live ? hash21(seed, tick * 0.73) : 0,
        tick,
      }
    },
    shade(cx, cy, bar, t, s) {
      const { pitch, head, track } = bar
      const d = head - (cx + 0.5) * pitch                 // px behind the head
      if (d < -0.5 * pitch) {
        /* one cell of forward spark, live only, now and then */
        if (!s.live || d < -1.5 * pitch || s.rowK[cy].rn > 0.5 || hash21(cy + s.tick * 1.9, bar.seed) < 0.6) return null
        return mix3(track, s.lut[LUT_N - 8], 0.45 + 0.3 * s.spark)
      }
      const r = s.rowK[cy]
      const x = d - s.nozzle * (1 - 0.3 * r.rn)            // px behind the nozzle, which is shorter at the outer rows
      let T
      if (x <= 0) {
        T = s.live ? 1 - 0.06 * r.rn : 0.66 * s.breath     // white core; not live, an ember in hot ink
      } else {
        const env = Math.exp(-x * r.invL)
        let diamond = 0
        if (s.bands.length && x * s.dReach < 2.2) {
          for (let i = 0; i < s.bands.length; i++) {
            const b = s.bands[i]
            const q = 1 - Math.abs(d - b.at) / (s.dW * (1 - 0.55 * r.rn))   // narrower at the outer rows: a diamond
            if (q > 0) diamond = Math.max(diamond, q * b.pulse)
          }
          diamond *= Math.exp(-x * s.dReach)
        }
        if (env < 0.02 && diamond < 0.02) T = 0
        else {
          /* striation: 1-D value noise along this row, sliding left with the stream */
          const u = (d - r.off) / s.lat
          const i0 = Math.floor(u), f = u - i0, w = f * f * (3 - 2 * f)
          const a = hash21(i0, r.salt), b = hash21(i0 + 1, r.salt)
          const streak = a + (b - a) * w
          T = env * (s.live ? 0.25 + 1.1 * streak * streak : 0.5 + 0.15 * streak) * s.breath + 0.9 * diamond
          T = Math.min(1, Math.max(T, s.live ? 1 - x / (2 * pitch) : 0))   // no seam behind the core
        }
      }
      if (T < 0.02) {
        /* the calm bed: a gentle lift toward the head, a fixed per-cell grain */
        const k = (0.8 + 0.2 * Math.min(1, (head - d) / head)) * (0.94 + 0.06 * hash21(cx, cy + 0.5))
        const bd = s.bed
        return [track[0] + (bd[0] - track[0]) * k, track[1] + (bd[1] - track[1]) * k, track[2] + (bd[2] - track[2]) * k]
      }
      return s.lut[Math.round(T * (LUT_N - 1))]
    },
    glow(bar, t, s) {
      const hot = mix3(WHITE, bar.ink.hot, s.live ? 0.45 : 0.9)
      return {
        x: bar.head - 3 * bar.pitch, y: bar.H / 2,
        rx: s.live ? 9 * bar.pitch : 5 * bar.pitch, ry: bar.H * 0.85,
        rgb: hot,
        alpha: s.live ? 0.38 + 0.12 * s.spark : 0.16 * s.breath,
      }
    },
  })
})()
