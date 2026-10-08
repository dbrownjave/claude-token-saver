/* The canvas's own boards (sections 0 to 6). Needs core.js. */
/* ============================== boards ============================== */
const NOTES = {
  collapsed: [
    'Savings come first, in tokens, with the estimate and the real spend beside it. "est" is always written out. Desktop adds the context figure and the next mark in the same row because there is room; the terminal moves them to the bar\'s label.',
    'The context bar is the only alarm, and its colour follows the last threshold crossed. Upcoming marks are bright ticks, and the auto-compact buffer is drawn as dim, still cells. No knob: the end of the fill burns white-hot and its flames stream left on the wind, drawn by the fire option picked in section 0 (4 rows, pitch 3.5 px, about 2.6 px squares, on the 70 ms tick). The percentage lives in the text, not on the bar.',
  ],
  expanded: [
    'The headline is the same as collapsed. "e ▸" becomes "e ▾" and nothing else moves.',
    'The bar and its label are the same as collapsed.',
    'The ledger has one idea per line: a bold right-aligned number for the scan, then a dim label explaining it. Each number reads as "0" at session start.',
    'The month total carries across sessions. It is the only other place a dollar appears, and the rate is labelled with its source: your rate, or derived from your bill.',
    'The cache bar drains as the TTL runs out, green when warm and grey when cold. The hit rate is shown here, not in the ledger.',
    'The split bar is the only place category colours appear. Its segments follow the order things load: system, tools, memory, skills, MCP, messages.',
    'At most three rows, and each one has a command. The swatch ties the row to its segment. System, tools and free space never get a row.',
    'The "Next" line repeats the threshold the tick points at, with the distance in tokens and what to do when you reach it.',
    'There are always three buttons in a fixed order, so c/k/l stay in the same place. Primary depends on state (see board 5). Compact is drawn as unavailable when the cache is cold or unknown.',
  ],
  fresh: [
    'The headline still makes sense at zero: "0 tok so far". Cache shows "after 1st reply", not a blank or a dash.',
    'The bar shows the startup load in the calm colour, labelled "at startup", not "used". It is not live yet: the head is a quiet ember, with no wind until the first reply.',
    'All three ledger numbers are 0 with a reason ("no tool output yet"), so the column still lines up.',
    'The month total is known, and it is the only proof of value before the first reply.',
    'The cache bar is an empty track with "unknown until the first reply".',
    '"Loaded before you type": the breakdown is most useful now, because it is the entire cost of each turn.',
    'Shown only if the host reports a breakdown. Otherwise this block is left out, not drawn empty.',
    'The next mark is shown even at turn 0.',
    'Clear and Compact are unavailable because there is nothing to clear and no cache to compact. Later is primary. Hotkeys keep their positions.',
  ],
}
function notesList(arr) {
  const ul = document.createElement('ul'); ul.className = 'notes'
  arr.forEach((t, i) => { const li = document.createElement('li'); li.innerHTML = `<span class="n">${i + 1}</span><span>${t}</span>`; ul.append(li) })
  return ul
}
function pair(id, build, title, notes) {
  const host = document.getElementById(id)
  const left = desktop(build('desk'), title)
  if (notes) left.append(notesList(notes))
  host.append(left, terminal(build('term'), title))
}
pair('p-collapsed', (t) => collapsed(S.api, 'api', t), 'Context', NOTES.collapsed)
pair('p-expanded', (t) => expanded(S.api, 'api', t), 'Context', NOTES.expanded)
pair('p-fresh-c', (t) => collapsed(S.fresh, 'api', t), 'Context', null)
pair('p-fresh-e', (t) => expanded(S.fresh, 'api', t), 'Context', NOTES.fresh)

/* billing strip: headline + month line, desktop at 860 */
const MODES = [
  ['api', 'API · your rate', 'Dollars come from the $/M you set, and the real spend is shown next to the estimate.'],
  ['api-derived', 'API · rate from bill', 'Same as above, but the rate comes from this session\'s bill, so the month line says so.'],
  ['sub-new', 'Subscription · window not moved', 'Never a dollar. Until the five-hour window has moved, the line explains when a share will appear.'],
  ['sub', 'Subscription · window moved', 'Value is shown as a share of the five-hour window.'],
  ['unknown', 'Unknown billing', 'Tokens only. The expanded month line adds "set $/M in /config for dollars".'],
]
const sb = document.getElementById('s-billing')
for (const [m, lab, why] of MODES) {
  const d = { ...S.api, usd:{ ...S.api.usd, own:m === 'api' } }
  const l = document.createElement('div'); l.className = 'lab'; l.innerHTML = `<b>${lab}</b>`
  const p = document.createElement('div'); p.className = 'dpane'
  p.append(deskLine(headline(d, m, true, 'desk')))
  const led = ledger(d, m === 'unknown' ? 'unknown' : m)
  const month = m === 'unknown' ? [{ t:fmtK(d.month.tok), st:'b', col:6 }, { t:`  ${d.month.name}, across sessions · set $/M in /config for dollars`, st:'d' }] : led[3]
  p.append(deskLine(month))
  const w = document.createElement('div'); w.className = 'why'; w.textContent = why
  sb.append(l, p, w)
}

/* threshold strip */
const TH = [
  [30_000 + 31_000, true, 'calm · below watch', 'Calm blue. Later is primary because there is nothing to do yet.'],
  [96_000, true, 'amber · past watch', 'Amber. The next mark is handoff, so Later stays primary.'],
  [132_000, true, 'orange · past handoff', 'Orange. Clear becomes primary, after writing a handoff.'],
  [164_000, true, 'red · past compact, warm', 'Red with a warm cache. Compact is primary while the re-read is still cheap.'],
  [164_000, false, 'red · past compact, cold', 'Red with a cold cache. Compact is drawn unavailable, Clear is primary, and the line says why.'],
]
const st = document.getElementById('s-thresh')
for (const [used, warm, lab, why] of TH) {
  const d = { ...S.api, used, cache: warm ? S.api.cache : { known:true, warm:false } }
  const l = document.createElement('div'); l.className = 'lab'; l.innerHTML = `<b>${lab}</b>${pctOf(d)}%`
  const p = document.createElement('div'); p.className = 'dpane'
  for (const segs of collapsed(d, 'api', 'desk')) { delete segs.n; p.append(deskLine(segs)) }
  const a = actions(d); p.append(deskLine([{ blank:1 }]), deskLine(a.next), deskLine(a.btns))
  const w = document.createElement('div'); w.className = 'why'; w.textContent = why
  st.append(l, p, w)
}
const sw = document.getElementById('swatches')
for (const [k, c] of [['calm <40%', COL.calm], ['amber ≥ watch', COL.amber], ['orange ≥ handoff', COL.orange], ['red ≥ compact', COL.red], ['cache warm', COL.warm], ['cache cold', COL.cold], ['track', COL.track], ['auto-compact buffer', COL.buffer],
  ['split: system', CAT.system], ['tools', CAT.tools], ['memory', CAT.memory], ['skills', CAT.skills], ['MCP', CAT.mcp], ['messages', CAT.messages]]) {
  const e = document.createElement('div'); e.className = 'sw'; e.innerHTML = `<i style="background:${c}"></i>${k}`; sw.append(e)
}

/* strings table: plain text from the terminal model; desktop row 1 noted where it differs */
const tbl = document.getElementById('strings')
tbl.innerHTML = '<tr><th>State</th><th>Line</th><th>Terminal string (76 cells)</th><th>Cells</th><th>Desktop differs</th></tr>'
const STATES = [
  ['Collapsed · API', (t) => collapsed(S.api, 'api', t)],
  ['Expanded · API', (t) => expanded(S.api, 'api', t)],
  ['Collapsed · no response yet', (t) => collapsed(S.fresh, 'api', t)],
  ['Expanded · no response yet', (t) => expanded(S.fresh, 'api', t)],
]
const deskPlain = (segs) => segs.map((s) => s.sp ? '  ⟷  ' : s.bar ? '‹bar›' : s.btn ? `[${s.key}] ${s.btn}` : s.t).join('').trim()
for (const [name, build] of STATES) {
  tbl.insertAdjacentHTML('beforeend', `<tr class="grp"><td colspan="5">${name}</td></tr>`)
  const T = build('term'), D = build('desk')
  T.forEach((segs, i) => {
    if (segs[0] && segs[0].blank) return
    const r = termLine(segs), dp = deskPlain(D[i]), tp = deskPlain(segs)
    tbl.insertAdjacentHTML('beforeend', `<tr><td class="k">${segs.n ? `<span class="n">${segs.n}</span>` : ''}</td><td class="k">${i + 1}</td><td><code>${esc(r.plain)}</code></td><td class="k">${r.len}${r.len > TW ? ' ⚠' : ''}</td><td>${dp !== tp ? `<code>${esc(dp)}</code>` : '<span class="t-d">same</span>'}</td></tr>`)
  })
}

/* ============================== section 0: the context bar up close ============================== */
function focusSection() {
  const ctl = document.getElementById('fctl'), host = document.getElementById('focus'), opts = window.FIRE_OPTIONS
  const sim = { shown:0.48, target:0.48, playing:false, live:true, turnAt:0, turn:0, lastRaw:0, pct:-1 }
  ctl.innerHTML = `
    <div class="grp">Option <span id="fopts"></span></div>
    <div class="grp"><button id="fplay">▶ Play turns</button></div>
    <div class="grp">Fill <input id="ffill" type="range" min="2" max="100" value="48"><output id="ffillv">48%</output></div>
    <div class="grp">Wind <input id="fwind" type="range" min="0" max="300" value="100"><output id="fwindv">1.0×</output></div>
    <div class="grp"><button id="flive" class="on">Live</button><button id="fsmooth" title="The mod redraws every 70 ms; smooth shows what the effect would look like at 60 fps">Smooth (not in the mod)</button></div>`
  const $ = (id) => document.getElementById(id)
  const optBtns = opts.map((o) => { const b = document.createElement('button'); b.textContent = o.id; b.title = o.name; b.onclick = () => pick(o.id); $('fopts').append(b, ' '); return [o.id, b] })
  const INK_ROWS = [[0.30, 'calm'], [0.48, 'amber · past watch'], [0.66, 'orange · past handoff'], [0.82, 'red · past compact']]
  host.innerHTML = `
    <div class="frow"><div class="lab"><b>The pane</b>true size · 860 px</div>
      <div class="dpane"><div id="fheroText"></div><div class="dl"><div class="fbar" id="fhero"><canvas></canvas></div></div></div>
      <div class="why" id="fnote"></div></div>
    <div class="frow"><div class="lab"><b>The head ×3</b>270 px around the head</div>
      <div class="fzoom"><canvas id="fzoom"></canvas></div>
      <div class="why">Each square is one 2.6 px cell. Watch the heat leave the head and cool leftward through the threshold ink into the calm bed.</div></div>
    <div class="fsub">The four inks · same option, same wind</div>
    ${INK_ROWS.map(([f, l], i) => `<div class="frow"><div class="lab"><b>${l}</b>${Math.round(f * 100)}%</div><div class="fbar" id="fink${i}"><canvas></canvas></div><div class="why"></div></div>`).join('')}
    <div class="fsub">Terminal · the same cells on a 2-row half-block raster, no glow</div>
    <div class="frow"><div class="lab"><b>Terminal</b>80 columns</div>
      <div class="fterm"><pre><span class="c-border">│ </span><span id="ftermBar"></span><span id="ftermLab" class="c-n"></span><span class="c-border"> │</span></pre></div>
      <div class="why">The terminal shows two cell rows per text row, using the ▀ character with a foreground and a background colour. The white head has to come from the cells alone.</div></div>
    <div class="fsub">Every option · same fill, same clock</div>
    <div id="fgrid">${opts.map((o) => `<div class="frow" data-id="${o.id}"><div class="lab"><b>${o.id} · ${esc(o.name)}</b></div><div class="fbar"><canvas></canvas></div><div class="why">${esc(o.note || '')}<br><button data-use="${o.id}">Use ${o.id}</button></div></div>`).join('')}</div>`
  host.querySelectorAll('[data-use]').forEach((b) => { b.onclick = () => pick(b.dataset.use) })
  function pick(id) {
    FIRE.pick = id; localStorage.firePick = id
    const o = fireOpt()
    for (const [k, b] of optBtns) b.classList.toggle('on', o && k === o.id)
    host.querySelectorAll('#fgrid .frow').forEach((r) => r.classList.toggle('picked', o && r.dataset.id === o.id))
    $('fnote').innerHTML = o ? `<b style="color:var(--fg)">${o.id} · ${esc(o.name)}</b><br>${esc(o.note || '')}` : 'No fire option loaded.'
  }
  pick(FIRE.pick)
  $('fplay').onclick = () => { sim.playing = !sim.playing; $('fplay').textContent = sim.playing ? '❚❚ Pause' : '▶ Play turns'; $('fplay').classList.toggle('on', sim.playing); sim.turnAt = sim.lastRaw + 0.6 }
  $('ffill').oninput = (e) => { sim.playing = false; $('fplay').textContent = '▶ Play turns'; $('fplay').classList.remove('on'); sim.target = sim.shown = e.target.value / 100 }
  $('fwind').oninput = (e) => { FIRE.wind = e.target.value / 100; $('fwindv').textContent = FIRE.wind.toFixed(1) + '×' }
  $('flive').onclick = () => { sim.live = !sim.live; $('flive').classList.toggle('on', sim.live); $('flive').textContent = sim.live ? 'Live' : 'Not live (before the first reply)'; sim.pct = -1 }
  $('fsmooth').onclick = () => { FIRE.smooth = !FIRE.smooth; $('fsmooth').classList.toggle('on', FIRE.smooth) }

  const marks = MARKS.map((m) => m.p), W = 826
  const step = (raw) => {                                  // a reply lands every 1.4 s; near the top, Clear resets the window
    const dt = Math.min(0.1, raw - sim.lastRaw); sim.lastRaw = raw
    if (sim.playing && raw >= sim.turnAt) {
      sim.turn++; sim.turnAt = raw + 1.4
      sim.target = sim.target > 0.9 ? 0.08 : Math.min(0.97, sim.target + 0.025 + 0.045 * hash01(sim.turn))
    }
    sim.shown += (sim.target - sim.shown) * (1 - Math.exp(-dt * 5))
  }
  const draw = (t, raw) => {
    step(raw)
    const o = fireOpt(), pct = Math.round(sim.shown * 100), ink = ACCENT_INK[crossed(pct)], live = sim.live
    if (pct !== sim.pct) {
      sim.pct = pct; $('ffill').value = Math.max(2, pct); $('ffillv').textContent = pct + '%'
      const d = { ...(live ? S.api : S.fresh), used:Math.round(sim.shown * WIN) }
      const row = deskLine(headline(d, 'api', false, 'desk')); row.id = 'fheroText'; $('fheroText').replaceWith(row)
      const nm = nextMark(pct); $('ftermLab').textContent = ` ${pct}%${nm ? ` · ${nm.id} at ${nm.p}%` : ''}`
    }
    const at = { marks, auto:AUTO, pct }
    const hero = barInfo(ink, sim.shown, live, W, { seed:11 })
    paintFire($('fhero').firstChild, hero, o, t, at)
    const x0 = Math.max(0, Math.min(W - 270, hero.head - 230))
    paintFire($('fzoom'), hero, o, t, { ...at, scale:3, x0, w:270 })
    INK_ROWS.forEach(([f], i) => paintFire($('fink' + i).firstChild, barInfo(ACCENT_INK[crossed(f * 100)], f, live, W, { seed:21 + i }), o, t, { marks, auto:AUTO, pct:f * 100 }))
    const cols = 76 - $('ftermLab').textContent.length
    paintRaster($('ftermBar'), barInfo(ink, sim.shown, live, cols * 8, { rows:2, pitch:8, H:16, seed:11 }), o, t, at)
    host.querySelectorAll('#fgrid .frow').forEach((r) => {
      const ro = opts.find((x) => x.id === r.dataset.id)
      if (r.__vis !== false) paintFire(r.querySelector('canvas'), barInfo(ink, sim.shown, live, W, { seed:11 }), ro, t, at)
    })
  }
  const sec = document.getElementById('b-focus'); watch(sec)
  host.querySelectorAll('#fgrid .frow').forEach(watch)
  DRAWERS.push({ el:sec, draw })
}
const hash01 = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v) }

drawBars()
focusSection()
startClock()
