#!/usr/bin/env node
/* Checks a fire option against design/fire/README.md and, on request, shows it.
   node design/fire/check.mjs design/fire/F1.js [--ascii] [--png out.png]
   Exit 0 when every rule passes. */
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const argv = process.argv.slice(2)
const file = argv[0]
const flag = (k) => { const i = argv.indexOf(k); return i < 0 ? null : argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true }
if (!file) { console.error('usage: node check.mjs <option.js> [--ascii] [--png out.png]'); process.exit(2) }

/* the shipped shader, as the page loads it */
const here = dirname(fileURLToPath(import.meta.url))
let lib = null
try {
  let s = readFileSync(resolve(here, '../../plugins/token-saver/hooks/register.js'), 'utf8')
  s = s.split('\n').filter((l) => !/^import /.test(l)).join('\n').replace(/^export /gm, '')
  lib = new Function(s + '\nreturn {shadeCell,burstsAt,rowSeed,INKS,SH}')()
} catch { lib = null }

const src = readFileSync(file, 'utf8')
const window = { FIRE_OPTIONS: [] }
new Function('window', src)(window)
const opt = window.FIRE_OPTIONS[window.FIRE_OPTIONS.length - 1]

const INKS = lib ? lib.INKS : {
  blue:    { hot: [0.62, 0.76, 1.00], c0: [0.45, 0.62, 0.98], c1: [0.22, 0.40, 0.80] },
  waiting: { hot: [1.00, 0.82, 0.48], c0: [1.00, 0.80, 0.40], c1: [0.80, 0.55, 0.18] },
  orange:  { hot: [1.00, 0.74, 0.50], c0: [1.00, 0.62, 0.36], c1: [0.80, 0.40, 0.20] },
  failed:  { hot: [1.00, 0.60, 0.63], c0: [1.00, 0.50, 0.54], c1: [0.85, 0.25, 0.30] },
}
const INK_NAMES = ['blue', 'waiting', 'orange', 'failed']
const TRACK = [0.165, 0.165, 0.18]
const TICK = 0.07
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const LT = lum(TRACK)
const T0 = 3
const TS = Array.from({ length: 40 }, (_, i) => +(T0 + i * TICK).toFixed(2))

function mkBar(o = {}) {
  const { W = 826, H = 14, rows = 4, pitch = 3.5, shown = 0.48, ink = 'blue', live = true, seed = 137 } = o
  const wind = 'wind' in o ? o.wind : 1          // undefined is a real case: register.js has no wind slider
  const s = Math.max(shown, 0.02)
  return Object.freeze({ W, H, rows, pitch, cols: Math.ceil(W / pitch), shown: s, head: s * W, ink: INKS[ink], inkName: ink, seed, track: TRACK, live, wind, lib })
}
const TERM = { W: 55 * 8, H: 16, rows: 2, pitch: 8 }
function render(b, t) {
  const st = opt.frame ? opt.frame(b, t) : undefined
  const cells = []
  for (let cy = 0; cy < b.rows; cy++) { const row = []; for (let cx = 0; cx < b.cols; cx++) row.push(opt.shade(cx, cy, b, t, st)); cells.push(row) }
  return { cells, glow: opt.glow ? opt.glow(b, t, st) : null }
}
const px = (b, cx) => (cx + 0.5) * b.pitch
const okRgb = (c) => c === null || (Array.isArray(c) && c.length === 3 && c.every((v) => Number.isFinite(v) && v >= 0 && v <= 1))
const okGlow = (g) => g === null || g === undefined || (['x', 'y', 'rx', 'ry', 'alpha'].every((k) => Number.isFinite(g[k])) && g.alpha >= 0 && g.alpha <= 1 && okRgb(g.rgb) && g.rgb !== null)
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0 }
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2)

const results = []
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail })

/* 1. contract */
const shapeOk = !!opt && typeof opt.shade === 'function' && /^F\d+$/.test(opt.id || '') && !!opt.name && !!opt.note
check('contract', shapeOk, opt ? `${opt.id} · ${opt.name}` : 'no option pushed onto window.FIRE_OPTIONS')
if (!shapeOk) { report(); process.exit(1) }

/* 2. pure source (comments stripped) */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const banned = code.match(/Math\.random|Date\.now|performance\.now|new Date|\bdocument\.|requestAnimationFrame|setTimeout|setInterval|globalThis|window\.(?!FIRE_OPTIONS)/g)
check('pure source', !banned, banned ? [...new Set(banned)].join(', ') : 'no clocks, randomness, DOM or globals')

/* 3. valid output + deterministic, across inks, fills, live/not, desktop + terminal */
let bad = 0, nondet = 0, badGlow = 0, threw = null
for (const ink of INK_NAMES) for (const shown of [0.02, 0.3, 0.48, 0.66, 0.82, 1]) for (const live of [true, false]) for (const geo of [{}, TERM, { wind: undefined }, { wind: 0 }, { wind: 3 }]) {
  const b = mkBar({ ...geo, shown, ink, live })
  for (const t of [0, 0.07, 0.7, ...TS.slice(0, 6)]) {
    try {
      const a = render(b, t), c = render(b, t)
      if (JSON.stringify(a) !== JSON.stringify(c)) nondet++
      for (const row of a.cells) for (const v of row) if (!okRgb(v)) bad++
      if (!okGlow(a.glow)) badGlow++
    } catch (e) { threw = threw || `${e.message} (ink ${ink}, shown ${shown}, live ${live}, t ${t})` }
  }
}
check('valid output', !threw && !bad && !badGlow, threw ? `threw: ${threw}` : `${bad} bad cells, ${badGlow} bad glows`)
check('deterministic', !threw && !nondet, `${nondet} frames differed between identical calls`)

/* 4–6. head white, ahead empty, fill reads, ink reads — desktop, each ink */
for (const [label, geo, whiteMin, aheadP] of [['desktop', {}, 0.7, 3], ['terminal', TERM, 0.6, 2]]) {
  const heads = [], aheadBad = [], fillNN = [], fillLum = [], sats = []
  for (const ink of INK_NAMES) {
    const b = mkBar({ ...geo, shown: 0.48, ink })
    const hw = [], fl = [], nn = []; let mix = [0, 0, 0], mixN = 0, ahead = 0
    for (const t of TS) {
      const { cells } = render(b, t)
      for (let cy = 0; cy < b.rows; cy++) for (let cx = 0; cx < b.cols; cx++) {
        const p = px(b, cx), c = cells[cy][cx]
        if (p >= b.head - 2 * b.pitch && p <= b.head + 0.5 * b.pitch) hw.push(c ? Math.min(...c) : 0)
        if (p > b.head + aheadP * b.pitch && c) ahead++
        if (p >= 0.3 * b.head && p <= b.head - 2 * b.pitch) { nn.push(c ? 1 : 0); fl.push(c ? lum(c) : LT) }
        if (p >= 0.3 * b.head && p <= 0.6 * b.head && c) { mix = mix.map((v, i) => v + c[i]); mixN++ }
      }
    }
    const m = mix.map((v) => v / Math.max(mixN, 1)), sat = Math.max(...m) ? (Math.max(...m) - Math.min(...m)) / Math.max(...m) : 0
    heads.push([ink, mean(hw)]); aheadBad.push([ink, ahead]); fillNN.push([ink, mean(nn)]); fillLum.push([ink, mean(fl) - LT]); sats.push([ink, sat])
  }
  const fmt = (a) => a.map(([k, v]) => `${k} ${typeof v === 'number' && v % 1 ? f2(v) : v}`).join(' · ')
  check(`${label}: head white (min channel ≥ ${whiteMin})`, heads.every(([, v]) => v >= whiteMin), fmt(heads))
  check(`${label}: nothing ahead (> ${aheadP} pitches)`, aheadBad.every(([, v]) => v === 0), fmt(aheadBad))
  check(`${label}: fill covered (≥ 0.95 cells lit)`, fillNN.every(([, v]) => v >= 0.95), fmt(fillNN))
  check(`${label}: fill lifted (lum ≥ track + 0.06)`, fillLum.every(([, v]) => v >= 0.06), fmt(fillLum))
  check(`${label}: ink reads in the bed (saturation ≥ 0.2)`, sats.every(([, v]) => v >= 0.2), fmt(sats))
}

/* 7. wind: features travel left, fast; and flicker */
function drift(b) {
  const hc = Math.floor(b.head / b.pitch), lo = Math.max(0, hc - 45), hi = hc - 3
  const prof = TS.concat([+(T0 + 40 * TICK).toFixed(2)]).map((t) => {
    const { cells } = render(b, t), p = []
    for (let cx = lo; cx <= hi; cx++) { let s = 0; for (let cy = 0; cy < b.rows; cy++) s += cells[cy][cx] ? lum(cells[cy][cx]) : LT; p.push(s / b.rows) }
    return p
  })
  const n = prof[0].length, avg = Array.from({ length: n }, (_, x) => mean(prof.map((p) => p[x])))
  const dev = prof.map((p) => p.map((v, x) => v - avg[x]))
  const flick = mean(Array.from({ length: n }, (_, x) => Math.sqrt(mean(dev.map((p) => p[x] * p[x])))))
  const shifts = []
  for (let k = 0; k + 1 < dev.length; k++) {
    let best = 0, bestS = 0
    for (let s = -8; s <= 8; s++) {
      let c = 0
      for (let x = 0; x < n; x++) { const y = x + s; if (y >= 0 && y < n) c += dev[k][y] * dev[k + 1][x] }
      if (c > best) { best = c; bestS = s }
    }
    shifts.push(bestS)
  }
  return { med: median(shifts), left: mean(shifts.map((s) => s > 0 ? 1 : 0)), flick }
}
{
  const out = INK_NAMES.map((ink) => [ink, drift(mkBar({ shown: 0.48, ink }))])
  const d = out[0][1]
  check('wind: features drift left 1–6 cells/tick', out.every(([, r]) => r.med >= 1 && r.med <= 6),
    out.map(([k, r]) => `${k} ${r.med} (${Math.round(r.med * 3.5 / TICK)} px/s, ${Math.round(r.left * 100)}% of ticks leftward)`).join(' · '))
  check('wind: flicker (temporal std ≥ 0.03)', out.every(([, r]) => r.flick >= 0.03), out.map(([k, r]) => `${k} ${f2(r.flick)}`).join(' · '))
  const calm = drift(mkBar({ shown: 0.48, ink: 'blue', live: false }))
  check('not live is calmer', calm.flick <= d.flick, `flicker live ${f2(d.flick)} vs not live ${f2(calm.flick)}`)
}

/* 8. cost */
{
  const b = mkBar({ shown: 0.66, ink: 'orange' })
  for (let i = 0; i < 20; i++) render(b, T0 + i * TICK)
  const n = 120, s = performance.now()
  for (let i = 0; i < n; i++) render(b, T0 + i * TICK)
  const ms = (performance.now() - s) / n
  check('cost ≤ 2 ms per 826 px frame', ms <= 2, `${f2(ms)} ms`)
}

report()
if (flag('--ascii')) ascii()
const pngOut = flag('--png'); if (pngOut && pngOut !== true) { writeFileSync(pngOut, sheet()); console.log(`png → ${pngOut}`) }
process.exit(results.every((r) => r.ok) ? 0 : 1)

function report() {
  const w = Math.max(...results.map((r) => r.name.length))
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(w)}  ${r.detail}`)
  console.log(results.every((r) => r.ok) ? 'ALL PASS' : `${results.filter((r) => !r.ok).length} FAIL`)
}

function ascii() {
  const ramp = ' .:-=+*#%@'
  const b = mkBar({ shown: 0.48, ink: 'blue' }), hc = Math.floor(b.head / b.pitch), lo = hc - 70, hi = hc + 5
  console.log(`\nascii · blue · 48% · cols ${lo}..${hi} · head col ${hc} marked ^ · three consecutive ticks`)
  for (const t of [TS[10], TS[11], TS[12]]) {
    const { cells } = render(b, t)
    console.log(`t=${t}`)
    for (let cy = 0; cy < b.rows; cy++) {
      let s = ''
      for (let cx = lo; cx <= hi; cx++) { const c = cells[cy][cx]; s += c ? ramp[Math.min(9, Math.max(0, Math.round((lum(c) - LT) / (1 - LT) * 9)))] : ' ' }
      console.log('  ' + s)
    }
  }
  console.log('  ' + ' '.repeat(hc - lo) + '^')
}

/* contact sheet: 8 ticks ×4 around the head, the four inks ×4, the whole bar ×1.5, the terminal raster ×2 */
function sheet() {
  const BG = [0.106, 0.11, 0.137], blocks = []
  const crop = (b, t, scale, x0, w) => ({ b, t, scale, x0, w, h: b.H })
  const blue = mkBar({ shown: 0.48, ink: 'blue' })
  for (let i = 0; i < 8; i++) blocks.push(crop(blue, TS[10 + i], 4, blue.head - 230, 270))
  blocks.push(null)
  for (const ink of INK_NAMES) { const b = mkBar({ shown: [0.3, 0.48, 0.66, 0.82][INK_NAMES.indexOf(ink)], ink }); blocks.push(crop(b, TS[14], 4, b.head - 230, 270)) }
  blocks.push(null)
  blocks.push(crop(blue, TS[14], 1.3, 0, blue.W))
  const term = mkBar({ ...TERM, shown: 0.48, ink: 'blue' })
  blocks.push(crop(term, TS[14], 2, 0, term.W))
  blocks.push(crop(mkBar({ shown: 0.48, ink: 'blue', live: false }), TS[14], 4, blue.head - 230, 270))
  const PAD = 8, GW = Math.ceil(Math.max(...blocks.filter(Boolean).map((k) => k.w * k.scale))) + 2 * PAD
  const GH = blocks.reduce((h, k) => h + (k ? Math.ceil(k.h * k.scale) + PAD : 12), PAD)
  const img = new Float32Array(GW * GH * 3)
  for (let i = 0; i < GW * GH; i++) img.set(BG, i * 3)
  const put = (x, y, c, add) => { if (x < 0 || y < 0 || x >= GW || y >= GH) return; const i = (y * GW + x) * 3; for (let k = 0; k < 3; k++) img[i + k] = add ? Math.min(1, img[i + k] + c[k]) : c[k] }
  let y = PAD
  for (const k of blocks) {
    if (!k) { y += 12; continue }
    const { b, t, scale, x0, w } = k, { cells, glow } = render(b, t)
    for (let yy = 0; yy < Math.ceil(b.H * scale); yy++) for (let xx = 0; xx < Math.ceil(w * scale); xx++) put(PAD + xx, y + yy, TRACK)
    const half = 0.75 * b.pitch / 2
    for (let cy = 0; cy < b.rows; cy++) for (let cx = 0; cx < b.cols; cx++) {
      const p = px(b, cx); if (p < x0 - b.pitch || p > x0 + w + b.pitch) continue
      const c = cells[cy][cx]; if (!c) continue
      const term = b.rows === 2, hx = term ? b.pitch / 2 : half, hy = term ? b.H / 4 : half, cyp = term ? (cy + 0.5) * b.H / 2 : (cy + 0.5) * b.pitch
      for (let yy = Math.round((cyp - hy) * scale); yy < Math.round((cyp + hy) * scale); yy++)
        for (let xx = Math.round((p - x0 - hx) * scale); xx < Math.round((p - x0 + hx) * scale); xx++) if (xx >= 0 && xx < w * scale) put(PAD + xx, y + yy, c)
    }
    if (glow && b.rows !== 2) {
      for (let yy = 0; yy < Math.ceil(b.H * scale); yy++) for (let xx = 0; xx < Math.ceil(w * scale); xx++) {
        const dx = (xx / scale + x0 - glow.x) / glow.rx, dy = (yy / scale - glow.y) / glow.ry, d = Math.sqrt(dx * dx + dy * dy)
        if (d < 1) put(PAD + xx, y + yy, glow.rgb.map((v) => v * glow.alpha * (1 - d) * (1 - d)), true)
      }
    }
    y += Math.ceil(b.H * scale) + PAD
  }
  return png(GW, GH, img)
}
function png(w, h, f) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let yy = 0; yy < h; yy++) { raw[yy * (w * 3 + 1)] = 0; for (let i = 0; i < w * 3; i++) raw[yy * (w * 3 + 1) + 1 + i] = Math.round(Math.max(0, Math.min(1, f[yy * w * 3 + i])) * 255) }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcT[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
