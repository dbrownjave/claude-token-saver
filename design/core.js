/* Shared by the canvas and the M4 page: data, helpers, the view model, renderers, the bar engine and the clock.
   Definitions only; nothing here touches the page until a caller asks. */
/* ============================== data ============================== */
/* Colours are the shipped shader's inks (register.js INKS, c0), so the static terminal glyphs match the animated desktop cells. */
const COL = { calm:'#739efa', amber:'#ffcc66', orange:'#ff9e5c', red:'#ff808a', warm:'#73e6ad', cold:'#858591', track:'#2a2a2e', buffer:'#3d4153', mark:'#c9cede' }
const CAT = { system:'#dbb847', tools:'#ff9e5c', mcp:'#c7a8ff', memory:'#7ac77a', skills:'#73e6ad', messages:'#739efa', free:COL.track, buffer:COL.buffer }
const CAT_INK = { system:'yellow', tools:'orange', mcp:'running', memory:'green', skills:'done', messages:'blue' }
const ACCENT_INK = ['blue', 'waiting', 'orange', 'failed']     // calm → amber → orange → red
const MARKS = [{ id:'watch', p:40 }, { id:'handoff', p:60 }, { id:'compact', p:75 }]
const AUTO = 83                                 // auto-compact threshold, % of window
const WIN = 200_000

const base = {
  mode:'api', fresh:false, turns:23, used:96_000,
  split:{ system:3_000, tools:12_000, mcp:38_000, memory:2_000, skills:6_000, messages:35_000 },
  cache:{ known:true, warm:true, left:47, ttl:60, hit:94 },
  save:{ cacheRead:1_860_000, cacheSaved:1_674_000, trimmed:38_000, keptTurns:11, keptOut:412_000, rewrites:4, vetoes:1, vetoTok:88_000 },
  usd:{ rate:3.00, own:true, spent:4.12 },
  sub:{ moved:true, share:7 },
  month:{ name:'October', tok:14_800_000 },
}
const S = {
  api: base,
  fresh: { ...base, fresh:true, turns:0, used:61_000,
    split:{ system:3_000, tools:12_000, mcp:38_000, memory:2_000, skills:6_000, messages:0 },
    cache:{ known:false }, save:{ cacheRead:0, cacheSaved:0, trimmed:0, keptTurns:0, keptOut:0, rewrites:0, vetoes:0, vetoTok:0 }, usd:{ ...base.usd, spent:0 } },
}

/* ============================== helpers ============================== */
const fmtK = (n) => n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.?0+$/, '') + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
const pctOf = (d) => Math.round((100 * d.used) / WIN)
const total = (d) => d.save.cacheSaved + d.save.keptOut + d.save.vetoTok
const usd = (tok, d) => tok / 1e6 * d.usd.rate
const money = (x) => '$' + x.toFixed(2)
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
function crossed(p) { return MARKS.filter((m) => m.p <= p).length }
function accent(p) { return [COL.calm, COL.amber, COL.orange, COL.red][crossed(p)] }
function nextMark(p) { return MARKS.find((m) => m.p > p) || null }

/* ============================== view model ==============================
   A line is a list of segments:
     {t, st}      text; st = b (bold number) | d (dim label) | n | warm | cold | key | arrow
     {t, st, col} right-aligned number column (terminal: col cells; desktop: 8%)
     {sp:1}       flexible gap
     {bar:{...}}  a bar that takes the remaining width
     {btn, key, kind}  kind = primary | secondary | off
   Lines may carry .n (annotation number). */
function worthSegs(d, mode) {
  const tok = total(d)
  if (mode === 'api')     return [{ t:`  ≈${money(usd(tok, d))} est`, st:'n' }, { t:' · spent ', st:'d' }, { t:money(d.usd.spent), st:'n' }]
  if (mode === 'api-derived') return [{ t:`  ≈${money(usd(tok, d))} est`, st:'n' }, { t:' · spent ', st:'d' }, { t:money(d.usd.spent), st:'n' }]
  if (mode === 'sub')     return [{ t:`  ≈${d.sub.share}% of a 5-h window`, st:'n' }]
  if (mode === 'sub-new') return [{ t:'  window share once the 5-h window moves', st:'d' }]
  return [{ t:'  tokens only', st:'d' }]
}
function headline(d, mode, open, target) {
  const segs = d.fresh
    ? [{ t:'Saved ', st:'d' }, { t:'0 tok', st:'b' }, { t:' so far · first reply pending', st:'d' }]
    : [{ t:'Saved ', st:'d' }, { t:fmtK(total(d)) + ' tok', st:'b' }, ...worthSegs(d, mode)]
  segs.push({ sp:1 })
  if (target === 'desk') {
    const p = pctOf(d), nm = nextMark(p)
    segs.push({ t:'context ', st:'d' }, { t:`${fmtK(d.used)}/${fmtK(WIN)} ${p}%`, st:'n' }, { t:nm ? ` · ${nm.id} at ${nm.p}%` : '', st:'d' }, { t:'    ', st:'d' })
  }
  segs.push(...cacheChip(d))
  segs.push({ t:open ? '   e ▾' : '   e ▸', st:'key' })
  return segs
}
function cacheChip(d) {
  if (!d.cache.known) return [{ t:'cache ', st:'d' }, { t:'after 1st reply', st:'d' }]
  return d.cache.warm ? [{ t:'cache ', st:'d' }, { t:`warm ${d.cache.left}m`, st:'warm' }] : [{ t:'cache ', st:'d' }, { t:'cold', st:'cold' }]
}
function ctxBarLine(d, target) {
  const p = pctOf(d), nm = nextMark(p)
  const bar = { kind:'ctx', pct:p, color:accent(p), ink:ACCENT_INK[crossed(p)], live:!d.fresh, marks:MARKS.map((m) => m.p), auto:AUTO }
  if (target === 'desk') return [{ bar }]
  const tail = d.fresh ? ` ${p}% at startup` : ` ${p}%${nm ? ` · ${nm.id} at ${nm.p}%` : ''}`
  return [{ bar }, { t:tail, st:'n' }]
}
function collapsed(d, mode = 'api', target) {
  const L1 = headline(d, mode, false, target); L1.n = 1
  const L2 = ctxBarLine(d, target); L2.n = 2
  return [L1, L2]
}
function ledger(d, mode) {
  const s = d.save, col = 6
  const month = mode.startsWith('api')
    ? [{ t:`  ${d.month.name} · ≈${money(usd(d.month.tok, d))} est at ${money(d.usd.rate)}/M`, st:'d' }, { t:mode === 'api' ? ' (your rate)' : ' (from your bill)', st:'d' }]
    : [{ t:`  ${d.month.name}, across sessions`, st:'d' }]
  if (d.fresh) return [
    [{ t:'0', st:'b', col }, { t:'  from cache · counts once the first reply lands', st:'d' }],
    [{ t:'0', st:'b', col }, { t:'  trimmed · no tool output yet', st:'d' }],
    [{ t:'0', st:'b', col }, { t:'  vetoed · 0 quiet rewrites', st:'d' }],
    [{ t:fmtK(d.month.tok), st:'b', col }, ...month],
  ]
  return [
    [{ t:fmtK(s.cacheSaved), st:'b', col }, { t:`  from cache · ${fmtK(s.cacheRead)} read at a tenth of the price`, st:'d' }],
    [{ t:fmtK(s.keptOut), st:'b', col }, { t:`  trimmed · ${fmtK(s.trimmed)} cut from tool output, kept out of ${plural(s.keptTurns, 'turn')}`, st:'d' }],
    [{ t:fmtK(s.vetoTok), st:'b', col }, { t:`  vetoed · ${plural(s.vetoes, 'cold compact')} (re-cache avoided) · ${plural(s.rewrites, 'quiet rewrite')}`, st:'d' }],
    [{ t:fmtK(d.month.tok), st:'b', col }, ...month],
  ]
}
function cacheLine(d) {
  const c = d.cache
  if (!c.known) return [{ t:'cache  ', st:'d' }, { bar:{ kind:'cache', f:0, color:COL.cold, ink:'cold' } }, { t:'  unknown until the first reply', st:'d' }]
  if (!c.warm) return [{ t:'cache  ', st:'d' }, { bar:{ kind:'cache', f:0, color:COL.cold, ink:'cold' } }, { t:'  cold', st:'cold' }, { t:' · next turn re-reads everything', st:'d' }]
  return [{ t:'cache  ', st:'d' }, { bar:{ kind:'cache', f:c.left / c.ttl, color:COL.warm, ink:'done' } }, { t:'  warm', st:'warm' }, { t:` ${c.left}/${c.ttl} min · hit ${c.hit}%`, st:'d' }]
}
function where(d) {
  const sp = d.split, col = 6, rows = []
  if (sp.mcp > 20_000) rows.push([{ t:fmtK(sp.mcp), st:'b', col }, { t:'  ■ ', st:'sw', c:CAT.mcp }, { t:'MCP tools, every turn', st:'n' }, { t:'  → ', st:'arrow' }, { t:'/mcp, disable unused servers', st:'n' }])
  if (sp.messages > 0) rows.push([{ t:fmtK(sp.messages), st:'b', col }, { t:'  ■ ', st:'sw', c:CAT.messages }, { t:'messages', st:'n' }, { t:'  → ', st:'arrow' }, { t:'one task per session; Clear on a topic change', st:'n' }])
  if (sp.skills > 3_000) rows.push([{ t:fmtK(sp.skills), st:'b', col }, { t:'  ■ ', st:'sw', c:CAT.skills }, { t:'skills', st:'n' }, { t:'  → ', st:'arrow' }, { t:'/loadout, park the ones you never call', st:'n' }])
  const parts = ['system', 'tools', 'memory', 'skills', 'mcp', 'messages'].map((k) => ({ f:sp[k] / WIN, color:CAT[k], ink:CAT_INK[k] }))
  const head = [{ t:d.fresh ? `Where the ${fmtK(d.used)} goes · loaded before you type` : `Where the ${fmtK(d.used)} goes`, st:'d' }]
  const bar = [{ bar:{ kind:'split', parts, auto:AUTO } }]
  return [head, bar, ...rows.slice(0, 3)]
}
function actions(d) {
  const p = pctOf(d), nm = nextMark(p), cold = d.cache.known && !d.cache.warm
  let msg, prim
  if (d.fresh)           { msg = `watch at ${nm.p}%, ${fmtK(WIN * nm.p / 100 - d.used)} away: note decisions as you go`; prim = 'l' }
  else if (cold && p >= 60) { msg = `cache cold: Clear. Compact would re-cache ${fmtK(d.used)}`; prim = 'c' }
  else if (p >= 75)      { msg = `past compact: Compact now, while the cache is warm (${d.cache.left}m)`; prim = 'k' }
  else if (p >= 60)      { msg = 'past handoff: write a handoff, then Clear'; prim = 'c' }
  else if (nm)           { msg = `${nm.id} at ${nm.p}%, ${fmtK(WIN * nm.p / 100 - d.used)} away${nm.id === 'handoff' ? ': write a handoff, then Clear' : ': note decisions as you go'}`; prim = 'l' }
  const kind = (k) => (d.fresh && k !== 'l') || (k === 'k' && (cold || !d.cache.known)) ? 'off' : k === prim ? 'primary' : 'secondary'
  return {
    next:[{ t:'Next  ', st:'d' }, { t:msg, st:'n' }],
    btns:[{ btn:'Clear', key:'c', kind:kind('c') }, { t:'  ', st:'d' }, { btn:'Compact', key:'k', kind:kind('k') }, { t:'  ', st:'d' }, { btn:'Later', key:'l', kind:kind('l') }, { sp:1 }, { t:'e collapse · esc close', st:'key' }],
  }
}
function expanded(d, mode = 'api', target) {
  const [L1, L2] = collapsed(d, mode, target)
  L1.splice(L1.length - 1, 1, { t:'   e ▾', st:'key' })
  const led = ledger(d, mode); led[0].n = 3; led[3].n = 4
  const cl = cacheLine(d); cl.n = 5
  const w = where(d); w[1].n = 6; if (w[2]) w[2].n = 7
  const a = actions(d); a.next.n = 8; a.btns.n = 9
  return [L1, L2, [{ blank:1 }], ...led, [{ blank:1 }], cl, [{ blank:1 }], ...w, [{ blank:1 }], a.next, a.btns]
}

/* ============================== terminal renderer ============================== */
const TW = 76                                   // 80 − border(2) − pad(2)
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
function segText(s) {
  if (s.btn) return `[${s.key}] ${s.btn}`
  if (s.col) return String(s.t).padStart(s.col)
  return s.t || ''
}
function termBar(b, n) {
  const cells = []
  if (b.kind === 'ctx') {
    const fill = Math.round(b.pct / 100 * n), autoAt = Math.round(b.auto / 100 * n), mk = b.marks.map((p) => Math.round(p / 100 * n))
    for (let i = 0; i < n; i++) {
      if (i < fill) cells.push(['█', b.color])
      else if (mk.includes(i)) cells.push(['│', COL.mark])
      else if (i >= autoAt) cells.push(['▒', COL.buffer])
      else cells.push(['░', COL.track])
    }
  } else if (b.kind === 'cache') {
    const fill = Math.round(b.f * n)
    for (let i = 0; i < n; i++) cells.push(i < fill ? ['█', b.color] : ['░', COL.track])
  } else {
    let i = 0
    for (const pt of b.parts) { const k = Math.round(pt.f * n); for (let j = 0; j < k && i < n; j++, i++) cells.push(['█', pt.color]) }
    const autoAt = Math.round(b.auto / 100 * n)
    for (; i < n; i++) cells.push(i >= autoAt ? ['▒', COL.buffer] : ['░', COL.track])
  }
  let html = '', run = '', col = null
  for (const [ch, c] of cells) { if (c !== col && run) { html += `<span style="color:${col}">${run}</span>`; run = '' } col = c; run += ch }
  if (run) html += `<span style="color:${col}">${run}</span>`
  return html
}
function termLine(segs) {
  if (segs[0] && segs[0].blank) return { html:''.padEnd(TW), plain:'', len:0 }
  let fixed = 0
  for (const s of segs) if (!s.sp && !s.bar) fixed += segText(s).length
  const rem = Math.max(0, TW - fixed)
  let html = '', plain = ''
  for (const s of segs) {
    if (s.sp) { html += ' '.repeat(rem); plain += ' '.repeat(rem); continue }
    if (s.bar) { html += termBar(s.bar, rem); plain += '‹bar›'; continue }
    const t = segText(s)
    const cls = s.btn ? (s.kind === 'primary' ? 'c-btnp' : s.kind === 'off' ? 'c-btnx' : 'c-btn') : 'c-' + s.st
    const style = s.c ? ` style="color:${s.c}"` : ''
    html += `<span class="${cls}"${style}>${esc(t)}</span>`; plain += t
  }
  const len = fixed + (segs.some((s) => s.sp || s.bar) ? rem : 0)
  return { html: html + ' '.repeat(Math.max(0, TW - len)), plain: plain.replace(/\s+$/, ''), len }
}
function terminal(lines, title) {
  const wrap = document.createElement('div'); wrap.className = 'col'
  const lab = document.createElement('div'); lab.className = 'frame-label'; lab.innerHTML = `<b>Terminal</b> · 80 columns`
  const f = document.createElement('div'); f.className = 'tframe'
  const pre = document.createElement('pre')
  let ruler = ''; for (let i = 1; i <= 80; i++) ruler += i % 10 === 0 ? String(i / 10 % 10) : i % 5 === 0 ? '·' : ' '
  let out = `<div class="ruler">${ruler}</div>`
  const tl = `╭─ ${title} `; out += `<div class="c-border">${tl}${'─'.repeat(79 - tl.length)}╮</div>`
  let over = 0
  for (const segs of lines) {
    const r = termLine(segs); if (r.len > TW) over++
    out += `<div class="row${r.len > TW ? ' overflow' : ''}">${segs.n ? `<span class="n">${segs.n}</span>` : ''}<span class="c-border">│ </span>${r.html}<span class="c-border"> │</span></div>`
  }
  out += `<div class="c-border">╰${'─'.repeat(78)}╯</div>`
  pre.innerHTML = out; f.append(pre); wrap.append(lab, f)
  if (over) { const w = document.createElement('div'); w.className = 'warnbox'; w.textContent = `${over} line(s) over 76 cells`; wrap.append(w) }
  return wrap
}

/* ============================== desktop renderer ============================== */
function deskLine(segs) {
  const row = document.createElement('div'); row.className = 'dl'
  if (segs[0] && segs[0].blank) { row.classList.add('blank'); return row }
  if (segs.n) { const n = document.createElement('span'); n.className = 'n'; n.textContent = segs.n; row.append(n) }
  for (const s of segs) {
    if (s.sp) { const g = document.createElement('span'); g.className = 'sp'; row.append(g); continue }
    if (s.bar) { const b = document.createElement('span'); b.className = 'barbox'; b.__bar = s.bar; row.append(b); continue }
    if (s.btn) { const b = document.createElement('span'); b.className = 'dbtn ' + s.kind; b.innerHTML = `<kbd>${s.key}</kbd>${s.btn}`; row.append(b); continue }
    const t = document.createElement('span')
    t.className = 't-' + (s.st === 'sw' ? 'n' : s.st) + (s.col ? ' col' : '')
    if (s.c) t.style.color = s.c
    t.textContent = s.col ? s.t : s.t
    row.append(t)
  }
  return row
}
function desktop(lines, title) {
  const wrap = document.createElement('div'); wrap.className = 'col'
  const lab = document.createElement('div'); lab.className = 'frame-label'; lab.innerHTML = `<b>Desktop</b> · 860 px · host UI font, one size`
  const p = document.createElement('div'); p.className = 'dpane'
  p.innerHTML = `<div class="title"><span>${title}</span><span class="x">esc</span></div>`
  for (const segs of lines) p.append(deskLine(segs))
  wrap.append(lab, p)
  return wrap
}
/* ============================== bars ==============================
   Every bar: 14 px track, 4 rows, pitch 3.5 px, cells at 75 % of the pitch (≈2.6 px), redrawn on the mod's 70 ms tick.
   Context bars are drawn by the picked fire option (design/fire/F*.js, contract in design/fire/README.md). The cache bar
   runs the shipped shader (register.js shadeCell); the split bar stays flat so its left-hand categories stay visible.
   Served over http the shipped shader loads; opened as a file, options that need it draw nothing and the rest still run. */
let lib = null
const H = 14, ROWS4 = 4, PITCH = H / ROWS4, DPR = 2, TICK = 0.07
const TRACK_RGB = [0.165, 0.165, 0.18]
const INKS_LOCAL = {
  blue:    { hot:[0.62, 0.76, 1.00], c0:[0.45, 0.62, 0.98], c1:[0.22, 0.40, 0.80] },
  waiting: { hot:[1.00, 0.82, 0.48], c0:[1.00, 0.80, 0.40], c1:[0.80, 0.55, 0.18] },
  orange:  { hot:[1.00, 0.74, 0.50], c0:[1.00, 0.62, 0.36], c1:[0.80, 0.40, 0.20] },
  failed:  { hot:[1.00, 0.60, 0.63], c0:[1.00, 0.50, 0.54], c1:[0.85, 0.25, 0.30] },
}
fetch('../plugins/token-saver/hooks/register.js').then((r) => r.ok ? r.text() : Promise.reject(r.status)).then((src) => {
  src = src.split('\n').filter((l) => !/^import /.test(l)).join('\n').replace(/^export /gm, '')
  lib = new Function(src + '\nreturn {shadeCell,burstsAt,rowSeed,INKS,SH}')()
}).catch(() => {})
const rgbHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('')
const seedOf = (id) => { let h = 7; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) % 9973; return h }

/* the fire option in use: the page's pick, else F1 when present, else the newest loaded */
const FIRE_DEFAULT = 'F1'
const FIRE = { pick: localStorage.firePick || FIRE_DEFAULT, wind: 1, smooth: false }
function fireOpt(id) {
  const all = window.FIRE_OPTIONS
  return all.find((o) => o.id === (id || FIRE.pick)) || all.find((o) => o.id === FIRE_DEFAULT) || all[all.length - 1] || null
}
function barInfo(inkName, shown, live, W, geo = {}) {
  const rows = geo.rows || ROWS4, pitch = geo.pitch || PITCH, h = geo.H || H, s = Math.max(Math.min(shown, 1), 0.02)
  return { W, H:h, rows, pitch, cols:Math.ceil(W / pitch), shown:s, head:s * W, ink:(lib && lib.INKS[inkName]) || INKS_LOCAL[inkName],
    inkName, seed:geo.seed || 137, track:TRACK_RGB, live, wind:FIRE.wind, lib }
}
const errored = new Set()
function runOpt(opt, info, t) {
  try {
    const st = opt && opt.frame ? opt.frame(info, t) : undefined
    return { shade:(cx, cy) => opt ? opt.shade(cx, cy, info, t, st) : null, glow:opt && opt.glow ? opt.glow(info, t, st) : null }
  } catch (e) { if (!errored.has(opt.id)) { errored.add(opt.id); console.error(opt.id, e) } return { shade:() => null, glow:null } }
}
/* Paint a context bar into a canvas. o: { scale, x0, w (crop in bar px), marks, auto, pct, track, buffer, mark (themed colours) } */
function paintFire(cv, info, opt, t, o = {}) {
  const sc = o.scale || 1, x0 = o.x0 || 0, w = o.w || info.W, d = DPR * sc
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(info.H * d)) {
    cv.width = Math.round(w * d); cv.height = Math.round(info.H * d); cv.style.width = w * sc + 'px'; cv.style.height = info.H * sc + 'px'
  }
  const ctx = cv.getContext('2d'), half = 0.75 * info.pitch / 2
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, cv.width, cv.height)
  ctx.fillStyle = o.track || COL.track; ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, (x0 ? 0 : 4) * d); ctx.fill()
  const r = runOpt(opt, info, t)
  const cell = (cx, cy, col) => {
    const px = (cx + 0.5) * info.pitch - x0
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect((px - half) * d, ((cy + 0.5) * info.pitch - half) * d, half * 2 * d, half * 2 * d, Math.min(0.9, half * 0.35) * d); ctx.fill()
  }
  for (let cy = 0; cy < info.rows; cy++) for (let cx = 0; cx < info.cols; cx++) {
    const px = (cx + 0.5) * info.pitch
    if (px < x0 - info.pitch || px > x0 + w + info.pitch) continue
    if (o.auto && px >= o.auto / 100 * info.W && px > info.head + 3 * info.pitch) { cell(cx, cy, o.buffer || COL.buffer); continue }   // the auto-compact buffer, still
    let c = null; try { c = r.shade(cx, cy) } catch (e) { if (!errored.has(opt.id)) { errored.add(opt.id); console.error(opt.id, e) } }
    if (c) cell(cx, cy, rgbHex(c))
  }
  const g = r.glow
  if (g && g.alpha > 0) {                                 // one additive radial gradient: what an SVG radialGradient can do
    ctx.save(); ctx.globalCompositeOperation = 'lighter'
    ctx.translate((g.x - x0) * d, g.y * d); ctx.scale(g.rx * d, g.ry * d)
    const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, 1), [R, G, B] = g.rgb.map((v) => Math.round(v * 255))
    gr.addColorStop(0, `rgba(${R},${G},${B},${g.alpha})`); gr.addColorStop(1, `rgba(${R},${G},${B},0)`)
    ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore()
  }
  ctx.globalCompositeOperation = 'source-over'
  for (const m of o.marks || []) if (m > (o.pct ?? 0)) { const x = m / 100 * info.W - x0; ctx.fillStyle = o.mark || 'rgba(201,206,222,.75)'; ctx.fillRect((x - 0.75) * d, 0, 1.5 * d, info.H * d) }
  if (o.auto) { const x = o.auto / 100 * info.W - x0; ctx.fillStyle = o.markFaint || 'rgba(201,206,222,.35)'; ctx.fillRect((x - 0.5) * d, 0, 1 * d, info.H * d) }
}
/* The terminal: the same option on a 2-row half-block raster ("▀", top cell = foreground, bottom = background). */
function paintRaster(pre, info, opt, t, o = {}) {
  const r = runOpt(opt, info, t), buf = []
  for (let cx = 0; cx < info.cols; cx++) {
    const px = (cx + 0.5) * info.pitch, inBuf = o.auto && px >= o.auto / 100 * info.W && px > info.head + 2 * info.pitch
    const mark = (o.marks || []).some((m) => m > (o.pct ?? 0) && Math.floor(m / 100 * info.cols) === cx)
    if (inBuf) { buf.push(`<span style="color:${COL.buffer}">▒</span>`); continue }
    let a = null, b = null; try { a = r.shade(cx, 0); b = r.shade(cx, 1) } catch {}
    if (!a && !b && mark) { buf.push(`<span style="color:${COL.mark}">│</span>`); continue }
    buf.push(`<span style="color:${a ? rgbHex(a) : COL.track};background:${b ? rgbHex(b) : COL.track}">▀</span>`)
  }
  pre.innerHTML = buf.join('')
}

function barRow(b, id) {
  if (b.kind === 'cache') return { id, state:b.ink, live:false, shown:b.f, settledAt:0 }
  let acc = 0; const segments = b.parts.filter((p) => p.f > 0).map((p) => ({ end:(acc += p.f), ink:p.ink }))
  return { id, state:'blue', live:false, shown:acc, settledAt:0, segments }
}
function mountBar(box, i) {
  const b = box.__bar
  box.__id = `${b.kind}-${i}`
  if (b.kind !== 'ctx') box.__row = barRow(b, box.__id)
  box.innerHTML = '<canvas></canvas>'
  box.__cv = box.firstChild
  if (b.kind === 'split') { const k = document.createElement('i'); k.className = 'tick auto'; k.style.left = b.auto + '%'; box.append(k) }
  watch(box)
}
function drawBar(box, t) {
  const b = box.__bar, W = Math.floor(box.clientWidth)
  if (b.kind === 'ctx') {
    paintFire(box.__cv, barInfo(b.ink, b.pct / 100, b.live, W, { seed:seedOf(box.__id) }), fireOpt(), t, { marks:b.marks, auto:b.auto, pct:b.pct })
    return
  }
  const row = box.__row, cv = box.__cv
  if (cv.width !== W * DPR) { cv.width = W * DPR; cv.height = H * DPR; cv.style.width = W + 'px'; cv.style.height = H + 'px' }
  const ctx = cv.getContext('2d'), cols = Math.ceil(W / PITCH), head = Math.max(row.shown, 0.02) * W, half = 0.75 * PITCH / 2
  ctx.clearRect(0, 0, cv.width, cv.height)
  ctx.fillStyle = COL.track; ctx.beginPath(); ctx.roundRect(0, 0, W * DPR, H * DPR, 4 * DPR); ctx.fill()
  const cell = (cx, cy, col) => { const px = (cx + 0.5) * PITCH; ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect((px - half) * DPR, ((cy + 0.5) * PITCH - half) * DPR, half * 2 * DPR, half * 2 * DPR, 0.9 * DPR); ctx.fill() }
  const empty = b.kind === 'cache' && b.f === 0
  const seed = lib && lib.rowSeed(row), bursts = lib && !empty && b.kind === 'cache' ? lib.burstsAt(row, t, seed) : []
  for (let cy = 0; cy < ROWS4; cy++) for (let cx = 0; cx < cols; cx++) {
    const px = (cx + 0.5) * PITCH
    if (b.auto && px >= b.auto / 100 * W && px > head + PITCH) { cell(cx, cy, COL.buffer); continue }
    if (empty) continue
    if (lib && b.kind === 'cache') { const c = lib.shadeCell(row, cx, cy, cols, ROWS4, t, bursts, seed, PITCH, W); if (c) cell(cx, cy, rgbHex(c)) }
    else if (px <= head) {
      const sg = row.segments ? row.segments.find((s) => px / W <= s.end) : null
      cell(cx, cy, sg ? Object.values(CAT)[Object.values(CAT_INK).indexOf(sg.ink)] : b.color)
    }
  }
}

/* one clock for the page: the mod's 70 ms tick by default, every frame when "smooth" is on; only visible things redraw */
const DRAWERS = []
function watch(el) { el.__vis = false; new IntersectionObserver(([e]) => { el.__vis = e.isIntersecting }).observe(el) }
function startClock() {
  const t0 = performance.now(); let last = -1
  const frame = () => {
    const raw = (performance.now() - t0) / 1000, t = FIRE.smooth ? raw : Math.floor(raw / TICK) * TICK
    if (t !== last) { last = t; for (const f of DRAWERS) if (f.el.__vis) f.draw(t, raw) }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
function drawBars() {
  document.querySelectorAll('.dl .barbox').forEach((box, i) => { mountBar(box, i); DRAWERS.push({ el:box, draw:(t) => drawBar(box, t) }) })
}

