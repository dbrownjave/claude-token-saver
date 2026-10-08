/* M4, the picked layout (L5 refined). Reuses core.js (data, bar engine, clock) and mid-session.js (theme, rows, controls).
   Title: "Context  96k / 200k tok (48%)" … chevron, esc. Body: the F1 bar, full width. Bottom: cache · saved left, actions right. */
;(() => {
  const M = window.MID
  const ACC = ['info', 'warn', 'brand', 'bad']
  const STATE = { desk:localStorage.m4Desk || 'dark', term:localStorage.m4Term || 'dark', billing:localStorage.m4Billing || 'api', cardBars:localStorage.m4Bars || 'fire', cacheInd:localStorage.m4Ind || 'ember', savedUI:localStorage.m4Saved || 'hero' }   // the shipped default; 'ember' is the setting
  const BAR_STYLES = [['smooth', 'Smooth'], ['cells', 'Cells'], ['ember', 'Cells + ember'], ['fire', 'Cells + fire']]
  const views = []
  const GAP = 10
  const PALETTE_T = () => M.palette('cli', STATE.term)
  const savedTok = M.data.total
  const { nm, away } = M.data                              // the scenario's next mark and how far it is
  /* what the cards read that the plugin would track: context growth over the last turns (new), keep-warm, the 5-hour window */
  const GROWTH = 6_000                                       // tokens a turn, averaged over the last five main-thread turns
  const KEEPWARM = { pings:2, cap:5, every:4 }               // minutes between pings
  const WINDOW5H = { usage:34, time:54, resets:'2h 18m', share:7 }

  /* a scenario is what the closed pane depends on: fill, cache, whether anything was answered yet */
  const MAIN = { id:'main', used:M.data.d.used, cache:{ known:true, warm:true, left:M.data.d.cache.left }, open:false }
  const MAIN_OPEN = { ...MAIN, id:'main-open', open:true }
  const STATES = [
    { id:'fresh', label:'Before the first reply', used:61_000, cache:{ known:false }, fresh:true, why:'Nothing saved yet and no cache, so the hints say exactly that. Clear and Compact are unavailable; Later is the only action.' },
    { id:'calm', label:'Calm', used:60_000, cache:{ known:true, warm:true, left:52 }, why:'Under the first mark, so the colour is calm blue and Later is the default.' },
    { id:'handoff', label:'Past handoff', used:132_000, cache:{ known:true, warm:true, left:4 }, why:'Orange past handoff, so Clear is highlighted. Only 4 minutes of cache are left, so the dot turns amber.' },
    { id:'cold', label:'Past compact, cache cold', used:164_000, cache:{ known:true, warm:false }, why:'Red. The cache is cold, so Compact would re-cache everything: it is unavailable and Clear is highlighted.' },
  ]

  const pctOfUsed = (u) => Math.round((100 * u) / WIN)
  const accOf = (u) => ACC[crossed(pctOfUsed(u))]
  const gap = (n = 2) => ({ t:' '.repeat(n) })
  function chev(sc) { return { btn:sc.open ? '▴' : '▾', key:'e', kind:'chev', quiet:true, noKey:true, label:sc.open ? 'Less' : 'More', act:() => { sc.open = !sc.open; build() } } }
  function title(T, sc) {
    const pct = pctOfUsed(sc.used)
    return [{ t:'Context', role:'faint' }, gap(3), { t:`${fmtK(sc.used)} / ${fmtK(WIN)} tok`, role:'dim' }, { t:` (${pct}%)`, role:accOf(sc.used), b:true },
      { sp:1 }, chev(sc), ...(T === 'term' ? [] : [gap(), { t:'esc', role:'faint' }])]
  }
  /* the closed pane's cache indicator, in six variations: a small stand-in for the Cache card it opens into */
  const INDICATORS = [['dot', 'Dot'], ['square', 'Square'], ['gradsquare', 'Square, cache gradient'], ['cells', 'Mini cells'], ['ember', 'Mini cells + ember'], ['gauge', 'Gauge']]
  function indicator(sc, T, style) {
    const c = sc.cache, fill = c.known && c.warm ? c.left / (c.ttl || 60) : 0, P = T === 'term' ? null : null
    const label = !c.known ? 'Cache after 1st reply' : c.warm ? `Warm ${c.left}m` : 'Cold'
    if (style === 'dot') return [{ t:!c.known || !c.warm ? '○ ' : '● ', role:!c.known || !c.warm ? 'faint' : c.left <= 5 ? 'warn' : 'ok' }, { t:label, role:'faint' }]
    // every other style is drawn by the frame: desktop swaps the marker for an element, the terminal for coloured glyphs
    return [{ ind:{ style, fill, known:c.known, warm:c.known && c.warm }, t:T === 'term' ? indGlyphs(style, fill, c.known && c.warm).t : '\u2060' }, { t:' ' + label, role:'faint' }]
  }
  const IND_CELLS = 5
  function indGlyphs(style, fill, warm) {
    // terminal: plain text the row can measure, with the colours applied by termCtl-like spans in indTermHTML
    if (style === 'square' || style === 'gradsquare') return { t:warm ? '■' : '□' }
    if (style === 'gauge') return { t:warm ? '▁▂▃▄▅▆▇█'[Math.max(0, Math.min(7, Math.round(fill * 8) - 1))] : '□' }
    return { t:'▪'.repeat(IND_CELLS) }
  }
  function indTermHTML(ind, P) {
    const { style, fill, warm } = ind
    const trackC = P.dark ? CACHE_TRACK : P.track
    if (style === 'square') return `<span style="color:${warm ? warmColor(P) : P.faint}">${warm ? '■' : '□'}</span>`
    if (style === 'gradsquare' || style === 'gauge') return `<span style="color:${warm ? gradAt(fill) : P.faint}">${indGlyphs(style, fill, warm).t}</span>`
    const lit = warm ? Math.max(1, Math.ceil(fill * IND_CELLS)) : 0, cold = !warm && ind.known
    return Array.from({ length:IND_CELLS }, (_, i) => `<span style="color:${cold ? frozen(P) : i < lit ? gradAt((i + 0.5) / IND_CELLS) : trackC}">▪</span>`).join('')
  }
  function indDeskEl(ind, P) {
    const { style, fill, warm } = ind, trackC = P.dark ? CACHE_TRACK : P.track
    const box = document.createElement('span'); box.style.cssText = 'display:inline-flex;align-items:center;flex:none;margin-right:2px'
    const sq = (bg, extra = '') => { const x = document.createElement('span'); x.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:2px;background:${bg};${extra}`; return x }
    if (style === 'square') box.append(warm ? sq(warmColor(P)) : sq('transparent', `box-shadow:inset 0 0 0 1.5px ${P.faint}`))
    else if (style === 'gradsquare') box.append(warm ? sq(gradAt(fill)) : sq('transparent', `box-shadow:inset 0 0 0 1.5px ${P.faint}`))
    else if (style === 'gauge') {
      const g = sq(trackC, `position:relative;overflow:hidden;box-shadow:inset 0 0 0 1px ${M.hex(M.mix(trackC, P.faint, 0.4))}`)
      if (warm) { const f = document.createElement('span'); f.style.cssText = `position:absolute;left:0;right:0;bottom:0;height:${(100 * fill).toFixed(0)}%;background:${gradAt(fill)}`; g.append(f) }
      box.append(g)
    } else if (style === 'cells') {
      const lit = warm ? Math.max(1, Math.ceil(fill * IND_CELLS)) : 0
      for (let i = 0; i < IND_CELLS; i++) { const x = sq(!warm && ind.known ? frozen(P) : i < lit ? gradAt((i + 0.5) / IND_CELLS) : trackC, 'width:5px;height:5px;border-radius:1px;margin-right:2px'); box.append(x) }
    } else if (style === 'ember') {
      // a 34 px F1 bar in its calm mode, painted by the clock like the card bars
      const holder = document.createElement('span'); holder.style.cssText = 'display:inline-block;position:relative;width:34px;height:10px'
      const cv = document.createElement('canvas'); cv.className = 'cardbar'; cv.style.display = 'block'
      cv.__card = { title:'cache-mini', bar:warm ? { kind:'grad', fill:Math.max(fill, 0.05) } : { kind:'solid', fill:ind.known ? 1 : 0, color:frozen(P) } }
      cv.__style = warm ? 'ember' : 'cells'   // cold: every cell frozen blue, no glow; before the first reply: empty
      holder.append(cv); box.append(holder)
    }
    return box
  }
  function hints(sc, T = 'desk', style = STATE.cacheInd) {
    return [...indicator(sc, T, style), { t:' · ', role:'faint' }, { t:sc.fresh ? '0 saved' : `${fmtK(savedTok)} saved`, role:'faint' }]
  }
  function actions(sc) {
    const pct = pctOfUsed(sc.used), cold = sc.cache.known && !sc.cache.warm
    const prim = sc.fresh ? 'l' : cold && pct >= 60 ? 'c' : pct >= 75 ? 'k' : pct >= 60 ? 'c' : 'l'
    const off = (k) => (sc.fresh && k !== 'l') || (k === 'k' && (cold || !sc.cache.known))
    const pill = (k, label) => ({ btn:label, key:k, kind:'pill', prim:k === prim && !off(k), off:off(k) })
    return [pill('c', 'Clear'), gap(1), pill('k', 'Compact'), gap(1), pill('l', 'Later')]
  }
  /* ---------- the open readout, organised like Claude's own /context dialog ----------
     a thin split bar, one row per category (swatch · name · tokens dim · percent bright), then groups that open on click */
  const D = M.data.d, SPL = D.split
  const BUFFER = Math.round(WIN * (100 - AUTO) / 100)
  const CATS = [
    ['messages', 'Messages', SPL.messages, 'info'], ['mcp', 'MCP tools', SPL.mcp, 'brand'], ['skills', 'Skills', SPL.skills, 'ok'],
    ['system', 'System prompt', SPL.system, 'warn'], ['tools', 'System tools', SPL.tools, 'grey'], ['memory', 'Memory files', 2_608, 'grey'],
    ['buffer', 'Autocompact buffer', BUFFER, 'dark'], ['free', 'Free space', Math.max(0, WIN - D.used - BUFFER), 'darker'],
    // deferred: tool schemas that load only when a tool is used; listed like /context, with no share of the window
    ['mcpDeferred', 'MCP tools (deferred)', 165_300, 'dark', true], ['sysDeferred', 'System tools (deferred)', 15_700, 'dark', true],
  ]
  const tok1 = (n) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n)
  const pct1 = (n) => `${(100 * n / WIN).toFixed(1)}%`
  const swatch = (role, P) => role === 'grey' ? P.faint : role === 'dark' ? M.hex(M.mix(P.faint, P.bg, 0.45)) : role === 'darker' ? M.hex(M.mix(P.faint, P.bg, 0.72)) : P[role]
  /* the split bar in the rows' order: used categories, then free space, the autocompact buffer at the right end */
  const splitParts = (P) => [...CATS.filter(([k, , , , deferred]) => k !== 'buffer' && k !== 'free' && !deferred), CATS.find(([k]) => k === 'free'), CATS.find(([k]) => k === 'buffer')]
    .map(([, , n, role]) => ({ f:n / WIN, color:role === 'darker' ? null : swatch(role, P) }))
  function groups(sc) {
    const s = D.save, c = D.cache
    return [
      { id:'saved', label:'Saved this session', value:tok1(savedTok), meta:`≈ ${money(usd(savedTok, D))}`, metaRole:'ok', rows:[
        ['Cache reads', 'Billed at a tenth', tok1(s.cacheSaved)],
        ['Trimmed output', `Kept out of ${s.keptTurns} turns`, tok1(s.keptOut)],
        ['Re-cache saved', `${plural(s.vetoes, 'cold compaction')} blocked`, tok1(s.vetoTok)],
        [D.month.name, ` at ${money(D.usd.rate)}/M`, tok1(D.month.tok), `≈ ${money(usd(D.month.tok, D))}`],
      ] },
    ]
  }
  /* drill-down groups, like the › MCP tools / › Memory files / › Custom agents rows in Claude's /context:
     each opens to its items with their tokens. Numbers are the scenario's, shaped like a real setup. */
  const DRILL = [
    { id:'mcp', label:'MCP tools', count:277, act:['/mcp', 'Turn off servers you don\u2019t use', 'Up to −38k'], items:[
      ['claude-in-chrome', '22 tools', 9_400], ['computer-use', '27 tools', 8_100], ['Claude_Browser', '19 tools', 6_200],
      ['scheduled-tasks', '6 tools', 3_700], ['terminal', '5 tools', 2_600], ['visualize', '2 tools', 1_600], ['6 more servers', '14 tools', 6_400],
      ['7 deferred servers', '182 tools · Deferred', 165_300]] },
    { id:'memory', label:'Memory files', count:5, act:['/memory', 'Drop the duplicate token-budget.md', '−844'], items:[
      ['~/.claude/rules/token-budget.md', 'User', 844], ['.claude/rules/token-budget.md', 'Project · Loaded twice', 844, 'warn'],
      ['~/agentic/AGENTS.md', 'User', 822], ['memory/MEMORY.md', 'Auto memory', 67], ['~/.claude/CLAUDE.md', 'User', 31]] },
    { id:'agents', label:'Custom agents', count:10, act:['/agents', 'Remove agents you never spawn', 'Up to −971'], items:[
      ['gemini-agent', 'cc-gemini-plugin', 353], ['grok-rescue', 'grok', 122], ['grok-review', 'grok', 77], ['grok-plan', 'grok', 76],
      ['grok-execute', 'grok', 65], ['5 more', 'grok', 278]] },
    { id:'skills', label:'Skills', count:134, act:['/loadout', 'Park skills you never call', 'Up to −4.3k'], items:[
      ['dataviz', 'Built-in', 480], ['claude-api', 'Built-in', 360], ['anthropic-skills:docx', 'Plugin', 320],
      ['data:data-context-extractor', 'Plugin', 280], ['code-review', 'Built-in', 280], ['128 more', '', 4_280]] },
  ].map((g) => ({ ...g, tok:g.items.reduce((n, it) => n + it[2], 0) }))
  const OPEN_GROUPS = new Set()
  function readout(sc, T) {
    const own = STATE.savedUI !== 'card', all = cards(sc), cs = own ? all.filter((x) => x.title !== 'Saved') : all, parts = ['head', 'bar', 'line', 'foot']
    const grid = T === 'term' ? [cs.slice(0, 2), cs.slice(2)] : [cs]          // 80 columns fit two cards; 860 px fits a row
    const head = !own ? [] : T === 'term' ? [...savedTerm(STATE.savedUI, PALETTE_T(), sc.id).map((r) => ({ ro:'raw', r })), { ro:'gap' }] : [{ ro:'savedblock', ui:STATE.savedUI, key:sc.id }, { ro:'gap' }]
    const out = [...head, ...grid.flatMap((row, i) => [...(i ? [{ ro:'gap' }] : []), ...parts.map((part) => ({ ro:'cards', pair:row, part }))]), { ro:'gap' }, { ro:'bar' }, ...CATS.map(([id, label, n, role, deferred]) => ({ ro:'cat', id, label, n, role, deferred })), { ro:'gap' }]
    for (const g of DRILL) {
      const key = sc.id + ':' + g.id, open = OPEN_GROUPS.has(key)
      out.push({ ro:'group', g:{ label:g.label, value:tok1(g.tok), meta:String(g.count), rows:g.items }, open, key, drill:true })
      if (open) { for (const it of g.items) out.push({ ro:'item', it }); out.push({ ro:'act', a:g.act }) }
    }
    out.push({ ro:'gap' })
    for (const g of groups(sc).filter((g) => STATE.savedUI === 'card' || g.id !== 'saved')) {   // with its own block, Saved needs no group
      const open = OPEN_GROUPS.has(sc.id + ':' + g.id)
      out.push({ ro:'group', g, open, key:sc.id + ':' + g.id })
      if (!open) continue
      if (g.bar) out.push({ ro:'cachebar' })
      for (const r of g.rows || []) out.push({ ro:'kv', r })
      for (const r of g.tips || []) out.push({ ro:'tip', r })
    }
    return out
  }
  function lines(T, sc) {
    const body = [[{ bar:'ctx' }], [...hints(sc, T), { sp:1 }, ...actions(sc)]]
    if (!sc.open) return body
    return [body[0], ...readout(sc, T).map((ro) => ({ readout:ro })), [{ blank:1 }], body[1]]
  }

  /* ---------- the cache card: the shipped Context pane's own wording and gradient (register.js CTX.cache) ----------
     Cache · Warm / gradient bar / Warmth 78% · Hit 94% / 47m left of 60m. Cold and no-reply read the same way. */
  const CACHE_GRAD = ['#629cde', '#a8a38c', '#da934b'], CACHE_TRACK = '#2e2d29', WARM = '#ce9466', CAP = '#e9e6dc'
  function cacheCard() {
    const c = D.cache, ttl = c.ttl || 60
    if (!c.known) return { accent:'Cold', warm:false, fill:0, strong:'No response yet', rest:'', foot:'The clock starts after the first reply' }
    if (!c.warm) return { accent:'Cold', warm:false, fill:0, strong:'Warmth 0%', rest:` · Hit ${c.hit}%`, foot:`Idle ${c.idle || 6}m, past ${ttl}m` }
    return { accent:'Warm', warm:true, fill:c.left / ttl, strong:`Warmth ${Math.round(100 * c.left / ttl)}%`, rest:` · Hit ${c.hit}%`, foot:`${c.left}m left of ${ttl}m` }
  }
  /* the four cards, one anatomy: Title · accent / bar / Strong · rest / foot (each line fits 36 terminal cells) */
  const cap1 = (w) => w[0].toUpperCase() + w.slice(1)
  function cards(sc) {
    const k = cacheCard(), pct = pctOfUsed(sc.used), cold = sc.cache.known && !sc.cache.warm
    const cache = { title:'Cache', accent:k.accent, tone:k.warm ? 'warm' : k.accent === 'Cold' && D.cache.known ? 'cold' : 'faint', bar:{ kind:'grad', fill:k.fill }, strong:k.strong, rest:k.rest, foot:k.foot }
    /* the next mark: runway from the last mark crossed, tokens to go, turns at the recent growth rate */
    const next = MARKS.find((m) => m.p > pct), prev = [...MARKS].reverse().find((m) => m.p <= pct)
    let run
    if (next && !(next.id === 'compact' && cold)) {
      const lo = prev ? prev.p : 0, frac = (pct - lo) / (next.p - lo), left = Math.max(0, WIN * next.p / 100 - sc.used), turns = Math.max(1, Math.ceil(left / GROWTH))
      const then = { watch:'note decisions', handoff:'handoff + Clear', compact:'Compact while warm' }[next.id]
      const span = WIN * (next.p - lo) / 100, ext = Math.min(1, frac + GROWTH / span)   // dim: where the next turn should land
      run = { title:cap1(next.id), accent:`In ≈${turns} turn${turns === 1 ? '' : 's'}`, tone:ACC[crossed(next.p)], bar:{ kind:'solid', fill:frac, ext, tone:ACC[crossed(pct)] },
        strong:`Runway ${Math.round(frac * 100)}%`, rest:` · ${tok1(left)} to go`, foot:`Then ${then}` }
    } else if (!cold) {
      run = { title:'Compact', accent:'Now', tone:'bad', bar:{ kind:'solid', fill:1, tone:'bad' }, strong:`Past ${MARKS[2].p}%`, rest:' · Cache warm', foot:`Cheap while warm: ${sc.cache.left}m left` }
    } else {
      run = { title:'Clear', accent:'Now', tone:'bad', bar:{ kind:'solid', fill:1, tone:'bad' }, strong:`Past ${pct >= 75 ? 75 : 60}%`, rest:' · Cache cold', foot:`Compact would re-cache ${tok1(sc.used)}` }
    }
    /* the billing card: keep-warm on API, the 5-hour window on a subscription (Claude's own wording) */
    const api = STATE.billing === 'api'
    const bill = api
      ? { title:'Keep-warm', accent:'On', tone:'warm', bar:{ kind:'solid', fill:KEEPWARM.pings / KEEPWARM.cap, tone:'warm' }, strong:`Pings ${KEEPWARM.pings} of ${KEEPWARM.cap}`, rest:' · 0.1× each',
          foot:`Warm ${(KEEPWARM.cap - KEEPWARM.pings) * KEEPWARM.every}m more if away` }
      : { title:'Current session', accent:'', tone:'ok', bar:{ kind:'time', fill:WINDOW5H.usage / 100, ext:WINDOW5H.time / 100, tick:WINDOW5H.time / 100, tone:'ok' }, strong:`Usage ${WINDOW5H.usage}%`, rest:` · Time ${WINDOW5H.time}%`, foot:`Resets in ${WINDOW5H.resets}` }
    /* paying for itself: saved ÷ (saved + spent), both in fresh-input-token terms */
    const spentTok = D.usd.spent / D.usd.rate * 1e6, share = savedTok / (savedTok + spentTok)
    const saved = api
      ? { title:'Saved', accent:`${tok1(savedTok)} tok`, tone:'text', bar:{ kind:'solid', fill:share, tone:'ok' }, strong:`Cut ${Math.round(share * 100)}% of input`, rest:' · ', gain:`≈ ${money(usd(savedTok, D))}`, foot:`Spent ${money(D.usd.spent)} · ${tok1(D.month.tok)} in ${D.month.name.slice(0, 3)}` }   // spend stays faint: only money saved is green
      : { title:'Saved', accent:`${tok1(savedTok)} tok`, tone:'text', bar:{ kind:'solid', fill:share, tone:'ok' }, strong:`Cut ${Math.round(share * 100)}% of input`, rest:` · ≈ ${WINDOW5H.share}% of 5h`, foot:`${tok1(D.month.tok)} this month` }
    return [run, saved, bill, cache]
  }
  const toneColor = (tone, P) => tone === 'warm' ? warmColor(P) : tone === 'cold' ? coldColor(P) : P[tone] || P.text
  const coldColor = (P) => P.dark ? CACHE_GRAD[0] : M.hex(M.mix(CACHE_GRAD[0], '#000000', 0.2))
  const frozen = (P) => M.hex(M.mix(coldColor(P), P.dark ? CACHE_TRACK : P.track, 0.45))
  const warmColor = (P) => P.dark ? WARM : M.hex(M.mix(WARM, '#000000', 0.25))
  const gradAt = (f) => { const [a, b, c] = CACHE_GRAD; return f < 0.5 ? M.hex(M.mix(a, b, f / 0.5)) : M.hex(M.mix(b, c, (f - 0.5) / 0.5)) }

  /* desktop: two right-aligned number columns, tokens dim and percent bright, like the /context dialog */
  const COL_V = 84, COL_P = 64
  function roDesk(ro, P, sc) {
    const row = document.createElement('div'); row.className = 'ml'; row.style.minHeight = '24px'
    const num = (t, color, w, bold) => { const x = document.createElement('span'); x.textContent = t; x.style.cssText = `width:${w}px;text-align:right;color:${color};font-variant-numeric:tabular-nums;flex:none${bold ? ';font-weight:600' : ''}`; return x }
    const txt = (t, color) => { const x = document.createElement('span'); x.textContent = t; x.style.color = color; return x }
    const grow = () => { const x = document.createElement('span'); x.style.flex = '1'; return x }
    if (ro.ro === 'gap') { row.style.minHeight = '10px'; return row }
    if (ro.ro === 'savedblock') return savedDesk(ro.ui, P, ro.key)
    if (ro.ro === 'cards') {
      row.style.gap = '24px'; row.style.alignItems = 'center'
      if (ro.part === 'bar') { row.style.minHeight = '22px' } else if (ro.part === 'head') { row.style.marginTop = '2px' }
      for (const cd of ro.pair) {
        const cell = document.createElement('span'); cell.style.cssText = 'flex:1;min-width:0;display:block;white-space:pre;overflow:hidden;text-overflow:ellipsis'
        if (ro.part === 'head') {
          const h = txt(cd.title, P.text); h.style.fontWeight = '650'; cell.append(h)
          if (cd.accent) { const a = txt(cd.accent, toneColor(cd.tone, P)); a.style.fontWeight = '650'; cell.append(txt(' · ', P.faint), a) }
        } else if (ro.part === 'line') { cell.append(txt(cd.strong, P.text), txt(cd.rest, P.faint)); if (cd.gain) cell.append(txt(cd.gain, P.ok)) }
        else if (ro.part === 'foot') { if (Array.isArray(cd.foot)) for (const [x, r] of cd.foot) cell.append(txt(x, P[r])); else cell.append(txt(cd.foot, P.faint)) }
        else if ((ro.style || STATE.cardBars) !== 'smooth') {
          // the main bar's own language at card size: 3 rows of cells, 10 px; drawn on the clock (see paintCard)
          const box = document.createElement('span'); box.style.cssText = 'display:block;position:relative;height:10px;margin:6px 0'
          const cv = document.createElement('canvas'); cv.className = 'cardbar'; cv.style.display = 'block'
          cv.__card = cd; cv.__style = ro.style || STATE.cardBars
          box.append(cv); cell.append(box)
        }
        else {
          // the reference bar: 10 px, rounded; bright "now", a dim run to where it is heading, a white tick that stands proud
          const b = cd.bar, color = b.kind === 'grad' ? null : toneColor(b.tone, P), trackC = P.dark ? CACHE_TRACK : P.track
          const track = document.createElement('span')
          track.style.cssText = `display:block;position:relative;height:10px;border-radius:5px;background:${trackC};margin:6px 0`
          const seg = (w, bg, extra = '') => { const x = document.createElement('span'); x.style.cssText = `position:absolute;left:0;top:0;bottom:0;width:${(100 * Math.min(1, w)).toFixed(1)}%;border-radius:5px;background:${bg};${extra}`; return x }
          if (b.ext > b.fill) track.append(seg(b.ext, M.hex(M.mix(color, trackC, 0.55))))
          track.append(seg(b.fill, b.kind === 'grad' ? `linear-gradient(90deg,${CACHE_GRAD[0]},${CACHE_GRAD[1]} 50%,${CACHE_GRAD[2]})` : color,
            (b.kind === 'grad' ? `background-size:${b.fill ? (100 / b.fill).toFixed(1) : 100}% 100%;` : '') + `box-shadow:inset -2px 0 0 ${CAP}`))
          if (b.tick != null) { const tk = document.createElement('span'); tk.style.cssText = `position:absolute;top:-2px;bottom:-2px;left:calc(${(100 * b.tick).toFixed(1)}% - 1px);width:2px;border-radius:1px;background:${P.text}`; track.append(tk) }
          cell.append(track)
        }
        row.append(cell)
      }
      return row
    }
    if (ro.ro === 'chead' || ro.ro === 'cline' || ro.ro === 'cfoot' || ro.ro === 'cbar') {
      const k = cacheCard()
      if (ro.ro === 'chead') { row.style.marginTop = '2px'; const h = txt('Cache', P.text); h.style.fontWeight = '650'; const a = txt(k.accent, k.warm ? warmColor(P) : P.faint); a.style.fontWeight = '650'; row.append(h, txt(' · ', P.faint), a); return row }
      if (ro.ro === 'cline') { const st = txt(k.strong, P.text); row.append(st, txt(k.rest, P.faint)); return row }
      if (ro.ro === 'cfoot') { row.append(txt(k.foot, P.faint)); return row }
      // the bar: a rounded track; the gradient spans the whole track and the fill reveals it, with a light cap at the head
      row.style.minHeight = '18px'
      const track = document.createElement('span'), fill = document.createElement('span')
      track.style.cssText = `flex:1;height:8px;border-radius:4px;background:${P.dark ? CACHE_TRACK : P.track};overflow:hidden;display:block`
      fill.style.cssText = `display:block;height:100%;width:${(100 * k.fill).toFixed(1)}%;border-radius:4px;background:linear-gradient(90deg,${CACHE_GRAD[0]},${CACHE_GRAD[1]} 50%,${CACHE_GRAD[2]});background-size:${k.fill ? (100 / k.fill).toFixed(1) : 100}% 100%;box-shadow:inset -2px 0 0 ${CAP}`
      track.append(fill); row.append(track); return row
    }
    if (ro.ro === 'bar' || ro.ro === 'cachebar') {
      row.style.margin = ro.ro === 'bar' ? '2px 0 6px' : '0 0 4px 20px'
      const b = document.createElement('span'); b.className = 'mbar'; b.innerHTML = '<canvas></canvas>'
      b.__parts = ro.ro === 'bar' ? splitParts : (P) => [{ f:D.cache.left / D.cache.ttl, color:P.ok }]
      row.append(b); return row
    }
    if (ro.ro === 'cat') {
      const sw = document.createElement('span'); sw.style.cssText = `width:12px;height:12px;border-radius:3px;background:${swatch(ro.role, P)};margin-right:10px;flex:none`
      row.append(sw, txt(ro.label, ro.deferred ? P.dim : P.text), grow(), num(tok1(ro.n), P.faint, COL_V), num(ro.deferred ? '—' : pct1(ro.n), ro.deferred ? P.faint : P.text, COL_P))
      return row
    }
    if (ro.ro === 'group') {
      const g = ro.g, ch = document.createElement('span')
      ch.style.cssText = `width:12px;margin-right:10px;flex:none;color:${P.faint};display:inline-flex;transform:rotate(${ro.open ? 90 : 0}deg)`
      ch.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      if (g.rows || g.tips) { row.style.cursor = 'pointer'; row.onclick = () => { OPEN_GROUPS.has(ro.key) ? OPEN_GROUPS.delete(ro.key) : OPEN_GROUPS.add(ro.key); build() } } else ch.style.visibility = 'hidden'
      row.append(ch, txt(g.label, P.dim), grow(), num(g.value, P.faint, ro.drill ? COL_V : COL_V * 1.4), num(g.meta, g.metaRole ? P[g.metaRole] : ro.drill ? P.faint : P.dim, COL_P, !!g.metaRole))
      return row
    }
    if (ro.ro === 'act') {
      const [cmd, what, save] = ro.a
      row.style.paddingLeft = '22px'
      const l = document.createElement('span'); l.style.cssText = 'min-width:240px;flex:none;display:inline-flex;align-items:center'
      const fill = P.dark ? P.raised : M.hex(M.mix(P.bg, P.text, 0.07))
      const btn = document.createElement('span'); btn.className = 'mbtn'; btn.textContent = cmd; btn.title = `Run ${cmd}`
      btn.style.cssText += `;height:20px;padding:0 8px;border-radius:6px;border-color:transparent;background:${fill};color:${P.brand};cursor:pointer`
      btn.onclick = (e) => { e.stopPropagation(); ran(cmd) }
      l.append(txt('↳ ', P.faint), btn)
      row.append(l, txt(what, P.faint), grow(), num(`${save}/turn`, P.ok, COL_V * 1.2 + COL_P))
      return row
    }
    if (ro.ro === 'item') {
      const [name, detail, n, role] = ro.it
      row.style.paddingLeft = '22px'
      const l = txt(name, P.dim); l.style.cssText += ';min-width:240px;flex:none;overflow:hidden;text-overflow:ellipsis'
      row.append(l, txt(detail, role ? P[role] : P.faint), grow(), num(tok1(n), P.faint, COL_V), num('', P.dim, COL_P))
      return row
    }
    if (ro.ro === 'kv') {
      const [label, detail, value, gain] = ro.r
      row.style.paddingLeft = '22px'
      const l = txt(label, P.dim); l.style.cssText += ';width:150px;flex:none'
      row.append(l, ...(gain ? [txt(gain, P.ok)] : []), txt(detail, P.faint), grow(), num(value, P.text, COL_V, true), num('', P.dim, COL_P))
      return row
    }
    if (ro.ro === 'tip') {
      const [label, cmd, rest, value] = ro.r
      row.style.paddingLeft = '22px'
      const l = txt(label, P.dim); l.style.cssText += ';width:150px;flex:none'
      row.append(l, txt(cmd, P.brand), txt('  ' + rest, P.faint), grow(), num(value, P.faint, COL_V), num('', P.dim, COL_P))
      return row
    }
    return row
  }

  /* terminal: the same columns in 76 cells — label 57, tokens 10, percent 9 */
  function roTerm(ro, P) {
    const c = (t, color, bold) => `<span style="color:${color}${bold ? ';font-weight:700' : ''}">${esc(t)}</span>`
    const W = M.TW
    if (ro.ro === 'gap') return { html:'', text:'', len:0 }
    if (ro.ro === 'raw') return ro.r
    if (ro.ro === 'cards') {
      const CW = 36, cell = (cd) => {
        if (ro.part === 'head') { const t = cd.title + (cd.accent ? ` · ${cd.accent}` : ''); return { t, h:c(cd.title, P.text, true) + (cd.accent ? c(' · ', P.faint) + c(cd.accent, toneColor(cd.tone, P), true) : '') } }
        if (ro.part === 'line') return { t:cd.strong + cd.rest + (cd.gain || ''), h:c(cd.strong, P.text) + c(cd.rest, P.faint) + (cd.gain ? c(cd.gain, P.ok) : '') }
        if (ro.part === 'foot') return Array.isArray(cd.foot) ? { t:cd.foot.map(([x]) => x).join(''), h:cd.foot.map(([x, r]) => c(x, P[r])).join('') } : { t:cd.foot, h:c(cd.foot, P.faint) }
        const b = cd.bar, n = Math.round(Math.min(1, b.fill) * CW), tick = b.kind === 'time' ? Math.min(CW - 1, Math.round(b.tick * CW)) : -1
        let h = ''
        for (let x = 0; x < CW; x++) {
          if (x === tick) { h += `<span style="color:${P.text}">│</span>`; continue }
          const e = b.ext ? Math.round(Math.min(1, b.ext) * CW) : 0, trackC = P.dark ? CACHE_TRACK : P.track
          h += x < n ? `<span style="color:${x === n - 1 ? CAP : b.kind === 'grad' ? gradAt((x + 0.5) / CW) : toneColor(b.tone, P)}">█</span>`
            : x < e ? `<span style="color:${M.hex(M.mix(toneColor(b.tone, P), trackC, 0.55))}">█</span>` : `<span style="color:${trackC}">░</span>`
        }
        return { t:'‹bar›'.padEnd(CW), h, len:CW }
      }
      const [a, b = { t:'', h:'', len:0 }] = ro.pair.map(cell), pad = (x) => ' '.repeat(Math.max(0, CW - (x.len || x.t.length)))   // a row may hold one card
      const t = (a.t + pad(a)) + '    ' + b.t
      return { html:a.h + pad(a) + '    ' + b.h + pad(b), text:t, len:CW * 2 + 4 }
    }
    if (ro.ro === 'chead' || ro.ro === 'cline' || ro.ro === 'cfoot') {
      const k = cacheCard()
      if (ro.ro === 'chead') return { html:c('Cache', P.text, true) + c(' · ', P.faint) + c(k.accent, k.warm ? warmColor(P) : P.faint, true), text:`Cache · ${k.accent}`, len:8 + k.accent.length }
      if (ro.ro === 'cline') return { html:c(k.strong, P.text) + c(k.rest, P.faint), text:k.strong + k.rest, len:(k.strong + k.rest).length }
      return { html:c(k.foot, P.faint), text:k.foot, len:k.foot.length }
    }
    if (ro.ro === 'cbar') {
      const k = cacheCard(), n = Math.round(k.fill * W)
      let html = ''
      for (let x = 0; x < W; x++) html += x < n ? `<span style="color:${x === n - 1 ? CAP : gradAt((x + 0.5) / W)}">█</span>` : `<span style="color:${P.dark ? CACHE_TRACK : P.track}">░</span>`
      return { html, text:'‹cache bar›', len:W }
    }
    if (ro.ro === 'bar' || ro.ro === 'cachebar') {
      const ind = ro.ro === 'cachebar' ? 4 : 0, n = W - ind
      const parts = ro.ro === 'bar' ? splitParts(P) : [{ f:D.cache.left / D.cache.ttl, color:P.ok }]
      let html = ' '.repeat(ind)
      for (let x = 0; x < n; x++) { const f = (x + 0.5) / n; let a = 0, col = P.track; for (const pt of parts) { a += pt.f; if (f < a) { col = pt.color || P.track; break } } html += `<span style="color:${col}">▄</span>` }
      return { html, text:' '.repeat(ind) + '‹bar›', len:W }
    }
    if (ro.ro === 'cat') {
      const pc = ro.deferred ? '—' : pct1(ro.n)
      const t = `■ ${ro.label.padEnd(55)}${tok1(ro.n).padStart(10)}${pc.padStart(9)}`
      return { html:c('■ ', swatch(ro.role, P)) + c(ro.label.padEnd(55), ro.deferred ? P.dim : P.text) + c(tok1(ro.n).padStart(10), P.faint) + c(pc.padStart(9), ro.deferred ? P.faint : P.text), text:t, len:t.length }
    }
    if (ro.ro === 'group') {
      const g = ro.g, mark = g.rows || g.tips ? (ro.open ? '▾ ' : '▸ ') : '  '
      const t = `${mark}${g.label.padEnd(55)}${g.value.padStart(10)}${g.meta.padStart(9)}`
      return { html:c(mark, P.faint) + c(g.label.padEnd(55), P.dim) + c(g.value.padStart(10), P.faint) + c(g.meta.padStart(9), g.metaRole ? P[g.metaRole] : P.dim, !!g.metaRole), text:t, len:t.length }
    }
    if (ro.ro === 'act') {
      const [cmd, what, save] = ro.a
      const b = `[ ${cmd} ]`, w = what.slice(0, 37).padEnd(37)
      const t = `    ${('↳ ' + b).padEnd(16)}${w}${(save + '/turn').padStart(19)}`
      return { html:'    ' + c('↳ ', P.faint) + c(b.padEnd(14), P.brand) + c(w, P.faint) + c((save + '/turn').padStart(19), P.ok), text:t, len:t.length }
    }
    if (ro.ro === 'item') {
      const [name, detail, n, role] = ro.it
      const nm32 = (name.length > 31 ? name.slice(0, 30) + '…' : name).padEnd(32), d21 = detail.slice(0, 21).padEnd(21)
      const t = `    ${nm32}${d21}${tok1(n).padStart(10)}${''.padStart(9)}`
      return { html:'    ' + c(nm32, P.dim) + c(d21, role ? P[role] : P.faint) + c(tok1(n).padStart(10), P.faint) + ' '.repeat(9), text:t, len:t.length }
    }
    if (ro.ro === 'kv') {
      const [label, full, value, gain = ''] = ro.r, detail = full.slice(0, 37 - gain.length)   // the detail column is 37 cells; never push the numbers out
      const t = `    ${label.padEnd(16)}${(gain + detail).padEnd(37)}${value.padStart(10)}${''.padStart(9)}`
      return { html:'    ' + c(label.padEnd(16), P.dim) + c(gain, P.ok) + c(detail.padEnd(37 - gain.length), P.faint) + c(value.padStart(10), P.text, true) + ' '.repeat(9), text:t, len:t.length }
    }
    if (ro.ro === 'tip') {
      const [label, cmd, rest, value] = ro.r
      const tail = ('  ' + rest).slice(0, 37 - cmd.length).padEnd(37 - cmd.length)   // command + hint share the 37-cell detail column
      const t = `    ${label.padEnd(16)}${cmd}${tail}${value.padStart(10)}${''.padStart(9)}`
      return { html:'    ' + c(label.padEnd(16), P.dim) + c(cmd, P.brand) + c(tail, P.faint) + c(value.padStart(10), P.faint) + ' '.repeat(9), text:t, len:t.length }
    }
    return { html:'', text:'', len:0 }
  }

  /* in the plugin a press is $.command.run({ command }), the same path Clear takes; here a toast says what would run */
  function ran(cmd) {
    let t = document.getElementById('m4toast')
    if (!t) { t = document.createElement('div'); t.id = 'm4toast'; t.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#30302e;color:#faf9f5;border-radius:8px;padding:8px 14px;font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.4);z-index:9;transition:opacity .2s'; document.body.append(t) }
    t.textContent = `Runs ${cmd}  ·  $.command.run({ command: '${cmd.slice(1)}' })`; t.style.opacity = '1'
    clearTimeout(t.__h); t.__h = setTimeout(() => { t.style.opacity = '0' }, 2200)
  }

  /* a row that may carry the cache indicator: drawn by M.deskRow, then the marker span becomes the element */
  function indRow(L, P) {
    const r = M.deskRow(L, P), g = L.find && L.find((x) => x.ind)
    if (g) { const mark = [...r.childNodes].find((n) => n.textContent === '\u2060'); if (mark) mark.replaceWith(indDeskEl(g.ind, P)) }
    return r
  }

  /* ---------- Saved: its own block under the main bar (it is the headline of the whole plugin) ----------
     five variations; 'card' keeps it as one of the four cards for comparison */
  const SAVED_UIS = [['hero', 'S1 · Hero strip'], ['breakdown', 'S2 · Breakdown card'], ['receipt', 'S3 · Receipt'], ['versus', 'S4 · Versus bar'], ['turns', 'S5 · Per turn'], ['card', 'Card (before)']]
  const h01 = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v) }
  const SOURCES = () => [
    { label:'Cache reads', note:'Billed at a tenth', tok:D.save.cacheSaved },
    { label:'Trimmed output', note:`Kept out of ${D.save.keptTurns} turns`, tok:D.save.keptOut },
    { label:'Re-cache saved', note:`${plural(D.save.vetoes, 'cold compaction')} blocked`, tok:D.save.vetoTok },
  ]
  const usdOf = (n) => money(usd(n, D))
  const isApi = () => STATE.billing === 'api'
  const shadeOf = (i, P) => [P.ok, M.hex(M.mix(P.ok, P.text, 0.4)), M.hex(M.mix(P.ok, P.dark ? CACHE_TRACK : P.track, 0.5))][i]
  const PER_TURN = (() => {                                  // what each of the session's turns saved: grows with the cached prefix
    const n = D.turns || 23, raw = Array.from({ length:n }, (_, i) => (40 + i * 6) * (0.7 + 0.6 * h01(i + 3))), sum = raw.reduce((a, b) => a + b, 0)
    return raw.map((v) => Math.round(v / sum * savedTok))
  })()
  const wouldPay = () => D.usd.spent + usd(savedTok, D)
  const heroShare = () => savedTok / (savedTok + D.usd.spent / D.usd.rate * 1e6)   // saved ÷ (saved + spent), in fresh-input tokens
  /* the receipt: each source with dotted leaders, a rule, the total, what you paid, what you would have paid */
  const RECEIPTS = new Set()                                  // which panes have the receipt open (keyed per pane)
  function receiptDesk(P) {
    const el = (css = '', ...kids) => { const x = document.createElement('div'); x.style.cssText = css; x.append(...kids); return x }
    const t = (s, color) => { const x = document.createElement('span'); x.textContent = s; x.style.color = color; return x }
    const row = (...kids) => el('display:flex;align-items:center;min-height:21px;white-space:pre', ...kids)
    const src = SOURCES(), api = isApi(), rb = el('')
      const line = (label, tok, amount, lc, ac) => {
        const lead = el(`flex:1;border-bottom:1px dotted ${M.hex(M.mix(P.faint, P.bg, 0.4))};margin:0 10px;transform:translateY(4px)`)
        const tk = t(tok, P.faint); tk.style.cssText += ';width:60px;text-align:right;font-variant-numeric:tabular-nums'
        const am = t(amount, ac); am.style.cssText += ';width:84px;text-align:right;font-variant-numeric:tabular-nums'
        return row(t(label, lc), lead, tk, ...(api ? [am] : []))
      }
      src.forEach((x) => rb.append(line(x.label, tok1(x.tok), `≈ ${usdOf(x.tok)}`, P.dim, P.ok)))
      rb.append(el(`height:1px;background:${P.line};margin:6px 0`))
      rb.append(line('Total saved', tok1(savedTok), `≈ ${usdOf(savedTok)}`, P.text, P.ok))
      if (api) {
        rb.append(line('You paid', '', money(D.usd.spent), P.faint, P.text))
        rb.append(line('Without token-saver', '', `≈ ${money(wouldPay())}`, P.faint, P.faint))
      } else rb.append(line(`${D.month.name}, across sessions`, tok1(D.month.tok), '', P.faint, P.faint))
    return rb
  }
  /* desktop */
  function savedDesk(ui, P, paneKey = 'cmp') {
    const el = (css = '', ...kids) => { const x = document.createElement('div'); x.style.cssText = css; x.append(...kids); return x }
    const t = (s, color) => { const x = document.createElement('span'); x.textContent = s; x.style.color = color; return x }
    const sp = () => { const x = document.createElement('span'); x.style.flex = '1'; return x }
    const row = (...kids) => el('display:flex;align-items:center;min-height:21px;white-space:pre', ...kids)
    const trackC = P.dark ? CACHE_TRACK : P.track, src = SOURCES(), api = isApi()
    const bar = (parts, h = 10) => { const b = el(`display:flex;height:${h}px;border-radius:${h / 2}px;overflow:hidden;background:${trackC};margin:6px 0`); for (const [f, c] of parts) b.append(el(`width:${(100 * f).toFixed(2)}%;background:${c}`)); return b }
    const money2 = api ? [t(`≈ ${usdOf(savedTok)}`, P.ok), t(` · Spent ${money(D.usd.spent)}`, P.faint)] : [t(`≈ ${WINDOW5H.share}% of the 5-hour window`, P.ok)]
    const box = el('margin:2px 0 4px')
    if (ui === 'hero') {
      const share = heroShare(), parts = src.map((x, i) => ({ f:share * x.tok / savedTok, color:shadeOf(i, P) }))
      box.append(row(t('Saved ', P.text), t(`${tok1(savedTok)} tok`, P.ok), t(' this session · ', P.faint), t(`Cut ${Math.round(share * 100)}% of input`, P.text), sp(), ...money2))
      if (STATE.cardBars === 'smooth') box.append(bar([...parts.map((pt) => [pt.f, pt.color])]))
      else {
        // our progress bar: cells, burning per the cardBars setting; each source keeps its green, one fire at the head
        const holder = el('position:relative;height:10px;margin:6px 0'), cv = document.createElement('canvas')
        cv.className = 'cardbar'; cv.style.display = 'block'; cv.__card = { title:'saved-hero', bar:{ kind:'segments', fill:share, parts } }; cv.__style = STATE.cardBars
        holder.append(cv); box.append(holder)
      }
      const key = row(); key.style.gap = '18px'
      src.forEach((x, i) => { const k = el('display:inline-flex;align-items:center;gap:6px'); k.append(el(`width:9px;height:9px;border-radius:2px;background:${shadeOf(i, P)}`), t(x.label, P.faint), t(tok1(x.tok), P.text)); key.append(k) })
      // bottom right of the bar: the receipt toggle, in the desktop's own button look
      const open = RECEIPTS.has(paneKey), fillB = P.dark ? P.raised : M.hex(M.mix(P.bg, P.text, 0.07))
      const btn = document.createElement('span'); btn.className = 'mbtn'; btn.title = open ? 'Hide the receipt' : 'Show the receipt'
      btn.style.cssText += `;height:20px;padding:0 6px 0 9px;gap:4px;border-radius:6px;border-color:transparent;background:${fillB};color:${P.dim};cursor:pointer;margin-left:auto`
      btn.innerHTML = `Receipt<svg width="12" height="12" viewBox="0 0 12 12" style="transform:rotate(${open ? 180 : 0}deg)"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`
      btn.onclick = (e) => { e.stopPropagation(); open ? RECEIPTS.delete(paneKey) : RECEIPTS.add(paneKey); build() }
      key.append(btn); box.append(key)
      if (open) { const r = receiptDesk(P); r.style.cssText = `margin-top:8px;padding-top:6px;border-top:1px solid ${P.line}`; box.append(r) }
    } else if (ui === 'breakdown') {
      const share = savedTok / (savedTok + D.usd.spent / D.usd.rate * 1e6)
      const left = el('flex:1;min-width:0')
      left.append(row(t('Saved', P.text), t(' · ', P.faint), t(`${tok1(savedTok)} tok`, P.ok)), bar([[share, P.ok]]),
        row(t(`Cut ${Math.round(share * 100)}% of input`, P.text), ...(api ? [t(' · ', P.faint), t(`≈ ${usdOf(savedTok)}`, P.ok)] : [])),
        row(t(api ? `Spent ${money(D.usd.spent)} · ${tok1(D.month.tok)} in ${D.month.name.slice(0, 3)}` : `${tok1(D.month.tok)} in ${D.month.name.slice(0, 3)}`, P.faint)))
      const right = el('flex:1.15;min-width:0;padding-top:2px'), max = Math.max(...src.map((x) => x.tok))
      src.forEach((x, i) => {
        const r = row(); const l = t(x.label, P.dim); l.style.cssText += ';width:118px;flex:none'
        const mb = el(`flex:1;height:6px;border-radius:3px;background:${trackC};overflow:hidden;margin:0 12px`, el(`height:100%;width:${(100 * x.tok / max).toFixed(1)}%;background:${shadeOf(i, P)};border-radius:3px`))
        const v = t(tok1(x.tok), P.text); v.style.cssText += ';width:48px;text-align:right;font-variant-numeric:tabular-nums'
        r.append(l, mb, v); r.style.minHeight = '24px'; right.append(r)
      })
      box.append(el('display:flex;gap:28px;align-items:flex-start', left, right))
    } else if (ui === 'receipt') {
      box.append(receiptDesk(P))
    } else if (ui === 'versus') {
      const total = api ? wouldPay() : savedTok + D.usd.spent / D.usd.rate * 1e6, paid = api ? D.usd.spent : D.usd.spent / D.usd.rate * 1e6, f = 1 - paid / total
      box.append(row(t('Without token-saver ', P.faint), t(api ? `≈ ${money(total)}` : `${tok1(total)} tok`, P.text), sp(), t(api ? 'You paid ' : 'You sent ', P.faint), t(api ? money(paid) : `${tok1(paid)} tok`, P.text)))
      box.append(bar([[1 - f, M.hex(M.mix(P.text, trackC, 0.6))], [f, P.ok]], 12))
      box.append(row(t(`Paid ${Math.round((1 - f) * 100)}%`, P.faint), sp(), t('Saved ', P.text), t(api ? `≈ ${usdOf(savedTok)}` : `${tok1(savedTok)} tok`, P.ok), t(` (${Math.round(f * 100)}%)`, P.faint)))
      box.append(row(t(src.map((x) => `${x.label} ${api ? usdOf(x.tok) : tok1(x.tok)}`).join(' · '), P.faint)))
    } else if (ui === 'turns') {
      box.append(row(t('Saved ', P.text), t(`${tok1(savedTok)} tok`, P.ok), t(` over ${PER_TURN.length} turns`, P.faint), sp(), ...money2))
      const max = Math.max(...PER_TURN), chart = el('display:flex;align-items:flex-end;gap:3px;height:34px;margin:6px 0')
      PER_TURN.forEach((v, i) => chart.append(el(`flex:1;height:${Math.max(8, 100 * v / max).toFixed(0)}%;border-radius:2px;background:${i === PER_TURN.length - 1 ? P.ok : M.hex(M.mix(P.ok, trackC, 0.45))}`)))
      box.append(chart)
      const avg = Math.round(savedTok / PER_TURN.length)
      box.append(row(t(`Last turn +${tok1(PER_TURN[PER_TURN.length - 1])}`, P.text), t(` · Average ${tok1(avg)}/turn · ${D.month.name} ${tok1(D.month.tok)}`, P.faint)))
    }
    return box
  }
  function receiptTerm(P) {
    const W = M.TW, c = (s, color) => `<span style="color:${color}">${esc(s)}</span>`, src = SOURCES(), api = isApi(), out = []
    const L = (parts) => { let text = '', html = ''; for (const [s, col] of parts) { text += s; html += col ? c(s, col) : s } return { text, html, len:text.length } }
      const line = (label, tok, amount, lc, ac) => { const tail = tok.padStart(7) + (api ? amount.padStart(11) : ''), dots = W - label.length - tail.length - 2; return L([[label, lc], [' ' + '·'.repeat(Math.max(1, dots)) + ' ', P.line], [tok.padStart(7), P.faint], ...(api ? [[amount.padStart(11), ac]] : [])]) }
      src.forEach((x) => out.push(line(x.label, tok1(x.tok), `≈ ${usdOf(x.tok)}`, P.dim, P.ok)))
      out.push(L([['─'.repeat(W), P.line]]))
      out.push(line('Total saved', tok1(savedTok), `≈ ${usdOf(savedTok)}`, P.text, P.ok))
      if (api) { out.push(line('You paid', '', money(D.usd.spent), P.faint, P.text)); out.push(line('Without token-saver', '', `≈ ${money(wouldPay())}`, P.faint, P.faint)) }
    return out
  }
  /* terminal: 76 cells a line, the same content */
  function savedTerm(ui, P, paneKey = 'cmp') {
    const W = M.TW, c = (s, color) => `<span style="color:${color}">${esc(s)}</span>`, trackC = P.dark ? CACHE_TRACK : P.track, src = SOURCES(), api = isApi()
    const L = (parts) => { let text = '', html = ''; for (const [s, col] of parts) { text += s; html += col ? c(s, col) : s } return { text, html, len:text.length } }
    const spread = (left, right) => { const lt = left.map(([s]) => s).join(''), rt = right.map(([s]) => s).join(''); return L([...left, [' '.repeat(Math.max(1, W - lt.length - rt.length)), null], ...right]) }
    const cells = (parts, ch = '█') => { let html = '', x = 0; for (const [f, col] of parts) { const n = Math.round(f * W); html += c(ch.repeat(Math.min(n, W - x)), col); x += n } if (x < W) html += c('░'.repeat(W - x), trackC); return { text:'‹bar›', html, len:W } }
    const money2 = api ? [[`≈ ${usdOf(savedTok)}`, P.ok], [` · Spent ${money(D.usd.spent)}`, P.faint]] : [[`≈ ${WINDOW5H.share}% of 5h`, P.ok]]
    const out = []
    if (ui === 'hero') {
      const share = heroShare()
      out.push(spread([['Saved ', P.text], [`${tok1(savedTok)} tok`, P.ok], [' this session · ', P.faint], [`Cut ${Math.round(share * 100)}% of input`, P.text]], money2))
      out.push(cells(src.map((x, i) => [share * x.tok / savedTok, shadeOf(i, P)])))
      const open = RECEIPTS.has(paneKey)
      out.push(spread(src.flatMap((x, i) => [['■ ', shadeOf(i, P)], [x.label + ' ', P.faint], [tok1(x.tok), P.text], [i < src.length - 1 ? ' ' : '', null]]), [[`[ Receipt ${open ? '▴' : '▾'} ]`, P.dim]]))   // the ■ separates; one space keeps the button inside 76
      if (open) out.push(L([['─'.repeat(W), P.line]]), ...receiptTerm(P))
    } else if (ui === 'breakdown') {
      const share = savedTok / (savedTok + D.usd.spent / D.usd.rate * 1e6), CW = 36, max = Math.max(...src.map((x) => x.tok))
      const left = [
        [['Saved', P.text], [' · ', P.faint], [`${tok1(savedTok)} tok`, P.ok]],
        [['█'.repeat(Math.round(share * CW)), P.ok], ['░'.repeat(CW - Math.round(share * CW)), trackC]],
        [[`Cut ${Math.round(share * 100)}% of input`, P.text], ...(api ? [[' · ', P.faint], [`≈ ${usdOf(savedTok)}`, P.ok]] : [])],
        [[api ? `Spent ${money(D.usd.spent)} · ${tok1(D.month.tok)} in ${D.month.name.slice(0, 3)}` : `${tok1(D.month.tok)} this month`, P.faint]],
      ]
      const right = src.map((x, i) => { const n = Math.max(1, Math.round(x.tok / max * 12)); return [[x.label.padEnd(16), P.dim], ['█'.repeat(n), shadeOf(i, P)], ['░'.repeat(12 - n), trackC], [tok1(x.tok).padStart(8), P.text]] })
      right.push([['', null]])
      for (let i = 0; i < 4; i++) { const a = L(left[i]), b = L(right[i]); out.push({ text:a.text.padEnd(CW) + '    ' + b.text, html:a.html + ' '.repeat(Math.max(0, CW - a.len)) + '    ' + b.html, len:CW + 4 + b.len }) }
    } else if (ui === 'receipt') {
      out.push(...receiptTerm(P))
    } else if (ui === 'versus') {
      const total = api ? wouldPay() : savedTok + D.usd.spent / D.usd.rate * 1e6, paid = api ? D.usd.spent : D.usd.spent / D.usd.rate * 1e6, f = 1 - paid / total
      out.push(spread([['Without token-saver ', P.faint], [api ? `≈ ${money(total)}` : `${tok1(total)} tok`, P.text]], [[api ? 'You paid ' : 'You sent ', P.faint], [api ? money(paid) : `${tok1(paid)} tok`, P.text]]))
      out.push(cells([[1 - f, M.hex(M.mix(P.text, trackC, 0.6))], [f, P.ok]]))
      out.push(spread([[`Paid ${Math.round((1 - f) * 100)}%`, P.faint]], [['Saved ', P.text], [api ? `≈ ${usdOf(savedTok)}` : `${tok1(savedTok)} tok`, P.ok], [` (${Math.round(f * 100)}%)`, P.faint]]))
      out.push(L([[src.map((x) => `${x.label} ${api ? usdOf(x.tok) : tok1(x.tok)}`).join(' · ').slice(0, W), P.faint]]))
    } else if (ui === 'turns') {
      out.push(spread([['Saved ', P.text], [`${tok1(savedTok)} tok`, P.ok], [` over ${PER_TURN.length} turns`, P.faint]], money2))
      const max = Math.max(...PER_TURN), ramp = '▁▂▃▄▅▆▇█'
      out.push(L(PER_TURN.flatMap((v, i) => [[ramp[Math.max(0, Math.min(7, Math.round(v / max * 8) - 1))].repeat(2), i === PER_TURN.length - 1 ? P.ok : M.hex(M.mix(P.ok, trackC, 0.45))], [i < PER_TURN.length - 1 ? ' ' : '', null]])))
      out.push(L([[`Last turn +${tok1(PER_TURN[PER_TURN.length - 1])}`, P.text], [` · Average ${tok1(Math.round(savedTok / PER_TURN.length))}/turn · ${D.month.name} ${tok1(D.month.tok)}`, P.faint]]))
    }
    return out
  }

  /* ---------- frames ---------- */
  function desk(sc, P) {
    const pane = document.createElement('div'); pane.className = 'mpane'
    // one rhythm: the same 10 px above the bar (from the title) and below it (to the next row), inside 14 × 18 px padding
    pane.style.cssText = `background:${P.bg};border-color:${P.line};color:${P.dim};padding:14px 18px 16px`
    const tr = M.deskRow(title('desk', sc), P); tr.style.marginBottom = `${GAP}px`; pane.append(tr)
    // +2 under the bar: the 22 px buttons sit 2 px taller than the title text, so the visible gaps match
    lines('desk', sc).forEach((L, i) => { const r = L.readout ? roDesk(L.readout, P, sc) : indRow(L, P); if (i === 0) r.style.marginBottom = `${GAP + 2}px`; pane.append(r) })
    pane.__sc = sc
    return pane
  }
  function term(sc, P) {
    const tf = document.createElement('div'); tf.className = 'mterm'; tf.style.cssText = `background:${P.bg};border-color:${P.line}`
    /* the title rides in the top border, the chevron at its right end: ╭─ Context   96k / 200k tok (48%) ──── e ▾ ─╮ */
    const segs = title('term', sc).filter((g) => !g.sp), at = segs.findIndex((g) => g.kind === 'chev')
    const head = segs.slice(0, at), tail = segs.slice(at)
    const len = (a) => a.reduce((n, g) => n + M.segText(g).length, 0)
    const fill = 80 - 3 - len(head) - 2 - len(tail) - 3
    const span = (g) => g.btn ? M.termCtl(g, P) : `<span style="color:${M.colorOf(g, P)}${g.b ? ';font-weight:700' : ''}">${esc(M.segText(g))}</span>`
    let over = fill < 1 ? 1 : 0
    let html = `<div><span style="color:${P.line}">╭─ </span>${head.map(span).join('')}<span style="color:${P.line}"> ${'─'.repeat(Math.max(1, fill))} </span>${tail.map(span).join('')}<span style="color:${P.line}"> ─╮</span></div>`
    const bars = []
    for (const L of lines('term', sc)) {
      const r = L.readout ? { ...roTerm(L.readout, P), bars:[] } : M.termRow(L, P); if (r.len > M.TW) over++
      const g = !L.readout && L.find && L.find((x) => x.ind)
      if (g) r.html = r.html.replace(`>${esc(g.t)}</span>`, `>${indTermHTML(g.ind, P)}</span>`)
      if ((L.readout || r.len === 0) && r.len < M.TW) r.html += ' '.repeat(M.TW - r.len)   // blank and readout rows pad to the frame
      bars.push(...r.bars)
      html += `<div${r.len > M.TW ? ' class="overflow"' : ''}><span style="color:${P.line}">│ </span>${r.html}<span style="color:${P.line}"> │</span></div>`
    }
    html += `<div style="color:${P.line}">╰${'─'.repeat(78)}╯</div>`
    tf.innerHTML = `<pre>${html}</pre>`
    tf.__over = over
    tf.__sc = sc; tf.__bars = bars.map((b) => ({ ...b, el:tf.querySelector('#' + b.id) }))
    return tf
  }

  /* ---------- bars: the context bar follows the scenario's fill and threshold colour ---------- */
  const inkFrom = (base, P) => ({ hot:M.mix(base, '#ffffff', 0.45), c0:M.mix(base, base, 0), c1:M.mix(base, P.dark ? '#000000' : '#ffffff', 0.35) })
  function ctxInfo(sc, P, W, geo = {}) {
    const info = barInfo('blue', sc.used / WIN, !sc.fresh, W, { seed:31, ...geo })
    info.ink = inkFrom(P[accOf(sc.used)], P); info.track = M.mix(P.track, P.track, 0)
    return info
  }
  function draw(t) {
    const opt = fireOpt()
    for (const v of views) {
      if (v.pane) v.pane.querySelectorAll('.mbar').forEach((b) => {
        const W = Math.floor(b.clientWidth); if (!W) return
        if (b.__bar === 'ctx') paintFire(b.firstChild, ctxInfo(v.pane.__sc, v.P, W), opt, t, { marks:MARKS.map((m) => m.p), auto:AUTO, pct:pctOfUsed(v.pane.__sc.used), track:v.P.track, buffer:M.hex(M.mix(v.P.track, v.P.faint, 0.3)), mark:v.P.dim, markFaint:v.P.faint })
        else M.paintFlat(b.firstChild, W, v.P, b.__parts ? b.__parts(v.P).map((pt) => ({ ...pt, color:pt.color || null })) : M.flatParts(b.__bar, v.P))
      })
      if (v.pane) v.pane.querySelectorAll('canvas.cardbar').forEach((cv) => paintCard(cv, v.P, t, opt))
      if (v.tf) for (const tb of v.tf.__bars) {
        if (!tb.el) continue
        tb.el.innerHTML = tb.kind === 'ctx'
          ? rasterCtx(ctxInfo(v.tf.__sc, v.P, tb.cols * 8, { rows:2, pitch:8, H:16 }), v.P, opt, t)
          : M.rasterHTML(M.barInfoThemed(v.P, tb.cols * 8, { rows:2, pitch:8, H:16 }), v.P, opt, t, tb.kind)
      }
    }
  }
  /* card bars in cells: static cells, F1 calm (ember, not live), or F1 live (fire); the dim run and the tick on top */
  function paintCard(cv, P, t, opt) {
    const cd = cv.__card, b = cd.bar, style = cv.__style, W = Math.floor(cv.parentNode.clientWidth); if (!W) return
    const H = 10, rows = 3, pitch = H / rows, half = 0.75 * pitch / 2, d = 2, cols = Math.ceil(W / pitch)
    const trackC = P.dark ? CACHE_TRACK : P.track, grad = b.kind === 'grad'
    const segAt = (f) => { let a = 0; for (const pt of b.parts || []) { a += pt.f; if (f <= a) return pt } return (b.parts || [])[(b.parts || []).length - 1] }
    const color = b.color || (grad ? CACHE_GRAD[2] : b.parts ? b.parts[0].color : toneColor(b.tone, P)), dim = M.hex(M.mix(color, trackC, 0.55))
    const sizeUp = () => { if (cv.width !== W * d) { cv.width = W * d; cv.height = H * d; cv.style.width = W + 'px'; cv.style.height = H + 'px' } }
    const cell = (ctx, cx, cy, col) => { ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(((cx + 0.5) * pitch - half) * d, ((cy + 0.5) * pitch - half) * d, half * 2 * d, half * 2 * d, 0.7 * d); ctx.fill() }
    let ctx
    if (style === 'cells') {
      sizeUp(); ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height)
      ctx.fillStyle = trackC; ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, 3 * d); ctx.fill()
      for (let cx = 0; cx < cols; cx++) {
        const f = (cx + 0.5) / cols, col = f <= b.fill ? (grad ? gradAt(f) : b.parts ? segAt(f).color : color) : null
        if (col) for (let cy = 0; cy < rows; cy++) cell(ctx, cx, cy, col)
      }
    } else {
      // F1 at card size; the cache keeps its blue-to-orange story by cooling into blue instead of the darker orange
      const info = barInfo('blue', Math.max(b.fill, 0.02), style === 'fire', W, { rows, pitch, H, seed:seedOf(cd.title) })
      info.ink = grad ? { hot:M.mix(CACHE_GRAD[2], '#ffffff', 0.45), c0:M.mix(CACHE_GRAD[2], CACHE_GRAD[2], 0), c1:M.mix(CACHE_GRAD[0], CACHE_GRAD[0], 0) } : inkFrom(color, P)
      info.track = M.mix(trackC, trackC, 0)
      if (!b.parts) { paintFire(cv, info, opt, t, { track:trackC }); ctx = cv.getContext('2d') }
      else {
        // one fire for the whole bar (one frame), each cell shaded with the ink of the source it sits in
        sizeUp(); ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height)
        ctx.fillStyle = trackC; ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, 3 * d); ctx.fill()
        const st = opt && opt.frame ? opt.frame(info, t) : undefined, inks = new Map()
        for (let cx = 0; cx < cols; cx++) {
          const f = (cx + 0.5) / cols, pt = segAt(Math.min(f, b.fill))
          if (!inks.has(pt)) inks.set(pt, { ...info, ink:inkFrom(pt.color, P) })
          for (let cy = 0; cy < rows; cy++) { let c = null; try { c = opt.shade(cx, cy, inks.get(pt), t, st) } catch {} if (c) cell(ctx, cx, cy, rgbHex(c)) }
        }
      }
    }
    if (b.ext > b.fill) for (let cx = 0; cx < cols; cx++) { const f = (cx + 0.5) / cols; if (f > b.fill + 1 / cols && f <= b.ext) for (let cy = 0; cy < rows; cy++) cell(ctx, cx, cy, dim) }
    if (b.tick != null) { ctx.fillStyle = P.text; ctx.fillRect((b.tick * W - 1) * d, 0, 2 * d, H * d) }
  }
  function rasterCtx(info, P, opt, t) {
    const r = runOpt(opt, info, t), out = []
    for (let cx = 0; cx < info.cols; cx++) {
      let a = null, b = null; try { a = r.shade(cx, 0); b = r.shade(cx, 1) } catch {}
      out.push(`<span style="color:${a ? rgbHex(a) : P.track};background:${b ? rgbHex(b) : P.track}">▀</span>`)
    }
    return out.join('')
  }

  /* ---------- the page ---------- */
  const plain = (segs) => segs.readout ? roTerm(segs.readout, M.palette('cli', 'dark')).text.replace(/\s+$/, '') : segs.map((g) => g.sp ? '  ⟷  ' : g.bar ? '‹bar›' : g.blank ? '' : M.segText(g)).join('').trim()
  function build() {
    const PD = M.palette('desktop', STATE.desk), PT = M.palette('cli', STATE.term)
    const ctl = document.getElementById('ctl')
    ctl.innerHTML = `
      <div class="grp">Desktop ${['dark', 'light'].map((k) => `<button data-desk="${k}" class="${STATE.desk === k ? 'on' : ''}">${k}</button>`).join(' ')}</div>
      <div class="grp">Terminal ${['dark', 'light', 'dark-daltonized', 'light-daltonized'].map((k) => `<button data-term="${k}" class="${STATE.term === k ? 'on' : ''}">${k}</button>`).join(' ')}</div>
      <div class="grp">Saved UI ${SAVED_UIS.map(([k, l]) => `<button data-saved="${k}" class="${STATE.savedUI === k ? 'on' : ''}">${l.replace(/^S\d · /, '')}</button>`).join(' ')}</div>
      <div class="grp">Cache indicator ${INDICATORS.map(([k, l]) => `<button data-ind="${k}" class="${STATE.cacheInd === k ? 'on' : ''}">${l}</button>`).join(' ')}</div>
      <div class="grp">Card bars ${BAR_STYLES.map(([k, l]) => `<button data-bars="${k}" class="${STATE.cardBars === k ? 'on' : ''}">${l}</button>`).join(' ')}</div>
      <div class="grp">Billing ${[['api', 'API'], ['sub', 'Subscription']].map(([k, l]) => `<button data-bill="${k}" class="${STATE.billing === k ? 'on' : ''}">${l}</button>`).join(' ')}</div>`
    ctl.querySelectorAll('[data-desk]').forEach((b) => { b.onclick = () => { STATE.desk = localStorage.m4Desk = b.dataset.desk; build() } })
    ctl.querySelectorAll('[data-term]').forEach((b) => { b.onclick = () => { STATE.term = localStorage.m4Term = b.dataset.term; build() } })
    ctl.querySelectorAll('[data-saved]').forEach((b) => { b.onclick = () => { STATE.savedUI = localStorage.m4Saved = b.dataset.saved; build() } })
    ctl.querySelectorAll('[data-ind]').forEach((b) => { b.onclick = () => { STATE.cacheInd = localStorage.m4Ind = b.dataset.ind; build() } })
    ctl.querySelectorAll('[data-bars]').forEach((b) => { b.onclick = () => { STATE.cardBars = localStorage.m4Bars = b.dataset.bars; build() } })
    ctl.querySelectorAll('[data-bill]').forEach((b) => { b.onclick = () => { STATE.billing = localStorage.m4Billing = b.dataset.bill; build() } })
    views.length = 0

    const main = document.getElementById('main'); main.innerHTML = ''
    for (const sc of [MAIN, MAIN_OPEN]) {
      const block = document.createElement('div'); block.style.marginBottom = '26px'
      const pair = document.createElement('div'); pair.className = 'pair'
      const dc = document.createElement('div'); dc.className = 'col'; dc.innerHTML = `<div class="frame-label"><b>Desktop</b> · 860 px · ${PD.name} · ${sc.open ? 'open' : 'closed'}</div>`
      const pane = desk(sc, PD); dc.append(pane)
      const tc = document.createElement('div'); tc.className = 'col'; tc.innerHTML = `<div class="frame-label"><b>Terminal</b> · 80 columns · ${PT.name} · ${sc.open ? 'open' : 'closed'}</div>`
      const tf = term(sc, PT); tc.append(tf)
      if (tf.__over) tc.insertAdjacentHTML('beforeend', `<div class="warnbox">${tf.__over} line(s) over 80 columns</div>`)
      pair.append(dc, tc); block.append(pair); main.append(block)
      views.push({ pane, P:PD }, { tf, P:PT })
    }

    const sv = document.getElementById('savedui'); sv.innerHTML = ''
    const SAVED_WHY = {
      hero:'One line answers "what did it save": the tokens in green, the money on the right. One bar shows where the saving came from, with a key underneath. Quickest to read.',
      breakdown:'A two-column card: the "Cut 61% of input" bar on the left, each source with its own mini bar on the right. The most detail without opening anything.',
      receipt:'Reads like a bill: each source with dotted leaders, a rule, the total, what you paid, and what you would have paid without the plugin. Honest and familiar.',
      versus:'One bar of what you would have paid, split into what you paid and what was saved. It is the "paying for itself" story in one picture.',
      turns:'The saving on each turn as a small column chart, the last turn highlighted. It shows the saving growing as the session goes on (needs per-turn tracking).',
    }
    for (const [k, l] of SAVED_UIS.filter(([k]) => k !== 'card')) {
      const wrap = document.createElement('div'); wrap.style.marginBottom = '26px'
      wrap.innerHTML = `<div class="frame-label" style="margin-bottom:6px"><b>${l}</b>${k === STATE.savedUI ? ' · in use above' : ''}</div><p style="color:var(--dim);margin:0 0 10px;max-width:1100px">${SAVED_WHY[k]}</p>`
      const pair = document.createElement('div'); pair.className = 'pair'
      const pane = document.createElement('div'); pane.className = 'mpane'; pane.style.cssText = `background:${PD.bg};border-color:${PD.line};color:${PD.dim};padding:14px 18px 12px`
      pane.append(savedDesk(k, PD))
      const tf = document.createElement('div'); tf.className = 'mterm'; tf.style.cssText = `background:${PT.bg};border-color:${PT.line}`
      const lines = savedTerm(k, PT)
      tf.innerHTML = `<pre>${lines.map((r) => `<div${r.len > M.TW ? ' class="overflow"' : ''}><span style="color:${PT.line}">│ </span>${r.html}${' '.repeat(Math.max(0, M.TW - r.len))}<span style="color:${PT.line}"> │</span></div>`).join('')}</pre>`
      pair.append(pane, tf); wrap.append(pair); sv.append(wrap)
    }

    const ig = document.getElementById('indicators'); ig.innerHTML = ''
    const IND_STATES = [['Warm 47m', { known:true, warm:true, left:47 }], ['4m left', { known:true, warm:true, left:4 }], ['Cold', { known:true, warm:false }]]
    const IND_WHY = {
      dot:'Today: a green dot. Generic "on/healthy", unrelated to the Cache card it opens into.',
      square:'A square in the cache\u2019s warm orange, the same shape as the category swatches. An outline when cold.',
      gradsquare:'The square slides along the cache gradient as the TTL drains: orange when fresh, sand at half, blue just before it lapses. You can read the warmth from the colour alone.',
      cells:'Five tiny cells: the Cache card\u2019s bar shrunk to a glyph. The count lit is the warmth, coloured along the gradient. Opening the pane reveals the full bar.',
      ember:'The mini bar drawn with F1\u2019s calm ember, like the card bars: alive, but quiet. Warm burns orange and cools toward blue as it drains; cold is every cell frozen blue, still.',
      gauge:'One square that drains from the top: a fuel gauge in the gradient colour.',
    }
    ig.insertAdjacentHTML('beforeend', `<div class="lab"></div><div class="igrid igh">${IND_STATES.map(([l]) => `<span>${l}</span>`).join('')}<span>terminal · warm 47m</span></div><div></div>`)
    for (const [k, l] of INDICATORS) {
      const lab = document.createElement('div'); lab.className = 'lab'; lab.innerHTML = `<b>${l}</b>${k === STATE.cacheInd ? 'in use' : ''}`
      const grid = document.createElement('div'); grid.className = 'igrid'
      for (const [, cache] of IND_STATES) {
        const cell = document.createElement('div'); cell.className = 'icell'; cell.style.cssText = `background:${PD.bg};border-color:${PD.line}`
        cell.append(indRow(indicator({ cache }, 'desk', k), PD))   // the comparison shows the indicator and its label only
        grid.append(cell)
      }
      const tcell = document.createElement('div'); tcell.className = 'icell'; tcell.style.cssText = `background:${PT.bg};border-color:${PT.line};font:13px/1.35 "SF Mono",Menlo,monospace`
      const segs = [...indicator({ cache:IND_STATES[0][1] }, 'term', k), { t:' · ', role:'faint' }, { t:`${fmtK(savedTok)} saved`, role:'faint' }]
      tcell.innerHTML = segs.map((g) => g.ind ? indTermHTML(g.ind, PT) : `<span style="color:${M.colorOf(g, PT)}">${esc(g.t)}</span>`).join('')
      grid.append(tcell)
      const why = document.createElement('div'); why.className = 'why'; why.textContent = IND_WHY[k]
      ig.append(lab, grid, why); views.push({ pane:grid, P:PD })
    }

    const bs = document.getElementById('barstyles'); bs.innerHTML = ''
    const WHY = {
      smooth:'Today\u2019s cards: rounded fills, the reference look. Calm, and clearly secondary to the main bar.',
      cells:'The main bar\u2019s cells at card size, standing still. One visual language across the pane, and only the main bar moves.',
      ember:'Cells with F1 in its calm mode: a quiet glow at each head, no wind. The cards feel alive without competing with the main bar.',
      fire:'F1 live on every card. Five fires at once: it is the most on-brand, but the main bar stops being the one thing that moves.',
    }
    for (const [k, l] of BAR_STYLES) {
      const lab = document.createElement('div'); lab.className = 'lab'; lab.innerHTML = `<b>${l}</b>${k === STATE.cardBars ? 'in use above' : ''}`
      const pane = document.createElement('div'); pane.className = 'mpane'; pane.style.cssText = `background:${PD.bg};border-color:${PD.line};color:${PD.dim};padding:14px 18px 12px`
      for (const part of ['head', 'bar', 'line', 'foot']) pane.append(roDesk({ ro:'cards', pair:cards(MAIN), part, style:k }, PD, MAIN))
      const why = document.createElement('div'); why.className = 'why'; why.textContent = WHY[k]
      bs.append(lab, pane, why); views.push({ pane, P:PD })
    }

    const st = document.getElementById('states'); st.innerHTML = ''
    for (const sc of STATES) {
      const lab = document.createElement('div'); lab.className = 'lab'; lab.innerHTML = `<b>${esc(sc.label)}</b>${pctOfUsed(sc.used)}%`
      const pane = desk(sc, PD)
      const why = document.createElement('div'); why.className = 'why'; why.textContent = sc.why
      st.append(lab, pane, why); views.push({ pane, P:PD })
    }

    document.getElementById('notes').innerHTML = [
      '<b>The percentage left the bar.</b> It now sits in the title as "96k / 200k tok (48%)", with the percentage in the threshold colour. The bar runs the full width with nothing on it, so the fire has the whole track.',
      '<b>The chevron and esc share the title’s right end.</b> The title is the pane’s chrome, so opening and closing it lives there, and esc appears only once.',
      '<b>Bottom row: status left, actions right.</b> Cache and saved sit under the start of the bar, where the eye lands after reading the title. The buttons sit at the right, where the eye ends. Later stays at the far right because it is the default.',
      '<b>Opening never moves the title, the bar or the bottom row.</b> The detail slides in between the bar and the bottom row, so the buttons and the chevron stay in the same place in both states.',
      '<b>Buttons are the desktop app\u2019s own.</b> They copy the "Commit changes" button: raised fill, no border, rounded, slightly smaller than before, and no shortcut letters. The recommended action gets a slightly lighter fill and bold text. An unavailable action loses its fill. In the terminal they are the engine\u2019s own <code>[ Clear ]</code>.',
      '<b>Card bars burn like the main bar, and a setting can calm them.</b> The default is <code>cardBars: "fire"</code>: cells with F1 live on every card. <code>cardBars: "ember"</code> keeps the cells and the glow at each head but drops the wind, so only the main bar moves. It is a <code>/config</code> row: <i>Card bars · Fire (default) / Ember</i>. The terminal draws static cells either way.',
      '<b>No bold text.</b> The pane never sets a weight. The brief\u2019s "bold the number, dim the label" becomes colour alone: numbers and headings in the text colour, labels dim, details faint, and the percentage and accents in the threshold or state colour. Buttons tell the recommended action apart by fill, not weight.',
      '<b>Every number reads at zero:</b> before the first reply it says "cache after 1st reply · 0 saved", and Clear and Compact are drawn unavailable, not hidden, so nothing jumps when they appear.',
      '<b>Colour is the theme’s:</b> text, inactive, claude, success, warning and error on the terminal; text-000/200/400, accent-brand, success, danger and yellow on the desktop. Switch themes above to check light and colour-blind.',
    ].map((t) => `<li>${t}</li>`).join('')

    const tbl = document.getElementById('strings')
    tbl.innerHTML = '<tr><th>State</th><th>Line</th><th>Terminal string</th></tr>'
    for (const [name, sc] of [['Closed · 48%', { ...MAIN, open:false }], ['Open · 48%', { ...MAIN, open:true }], ...STATES.map((s) => [`Closed · ${s.label}`, s])]) {
      tbl.insertAdjacentHTML('beforeend', `<tr class="grp"><td colspan="3">${esc(name)}</td></tr>`)
      tbl.insertAdjacentHTML('beforeend', `<tr><td class="k"></td><td class="k">title</td><td><code>${esc(plain(title('term', sc)))}</code></td></tr>`)
      lines('term', sc).forEach((L, i) => { if (L.readout ? L.readout.ro !== 'gap' : !(L[0] && L[0].blank)) tbl.insertAdjacentHTML('beforeend', `<tr><td class="k"></td><td class="k">${i + 1}</td><td><code>${esc(plain(L))}</code></td></tr>`) })
    }
  }

  M.onReady(() => {
    build()
    const el = document.querySelector('.page'); watch(el)
    DRAWERS.push({ el, draw })
    startClock()
  })
})()
