/* Section M: mid-session iterations, drawn in Claude's own theme.
   Colours come from design/theme/claude-themes.json: the desktop app's CSS tokens (bg-*, text-*, accent-brand, success-*,
   danger-*) and the CLI's theme tables, whose keys (text, inactive, claude, success, warning, error, permission) are what a
   mod's Text color may name, so the terminal frames show exactly what the engine would resolve. Each variant is a list of
   lines in roles; a role resolves per surface and theme. Loaded after the canvas script: it reuses its data and helpers. */
;(() => {
  /* ---------- roles → tokens ---------- */
  const ROLE_KEYS = [
    // role,    what it is for,                          CLI theme key,  desktop token
    ['text',   'the number that matters',               'text',         'text-000'],
    ['dim',    'a label',                               'text',         'text-200'],
    ['faint',  'detail, separators, hints',             'inactive',     'text-400'],
    ['brand',  'commands, the orange threshold',        'claude',       'accent-brand'],
    ['info',   'calm threshold',                        'permission',   'accent-000'],
    ['ok',     'cache warm',                            'success',      'success-000 / success-100'],
    ['warn',   'amber threshold',                       'warning',      'yellow-200 / yellow-350'],
    ['bad',    'red threshold, cache cold refusal',     'error',        'danger-100'],
  ]
  let TH = null
  const mix = (a, b, k) => { const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); const x = p(a), y = p(b); return x.map((v, i) => v + (y[i] - v) * k) }
  const hex = (c) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')
  function palette(surface, theme) {
    if (surface === 'desktop') {
      const d = TH.desktop[theme], dark = theme === 'dark'
      return { name:`Desktop · ${theme}`, bg:d['bg-100'], raised:d['bg-000'], line:dark ? 'rgba(222,220,209,.15)' : 'rgba(31,30,29,.15)',
        text:d['text-000'], dim:d['text-200'], faint:d['text-400'], brand:d['accent-brand'], info:d['accent-000'],
        ok:dark ? d['success-000'] : d['success-100'], warn:dark ? '#fab219' : '#c98500', bad:d['danger-100']   /* danger-000 is too close to accent-brand on dark: orange and red must differ */,
        track:hex(mix(d['bg-100'], d['text-000'], dark ? 0.07 : 0.09)), dark }
    }
    const c = TH.cli[theme], dark = theme.startsWith('dark')
    const bg = dark ? '#151515' : '#ffffff'                     // the person's terminal; the engine never paints it
    return { name:`Terminal · ${theme}`, bg, raised:bg, line:c.subtle, text:c.text, dim:hex(mix(c.text, bg, 0.22)), faint:c.inactive,
      brand:c.claude, info:c.permission, ok:c.success, warn:c.warning, bad:c.error, track:hex(mix(bg, c.text, dark ? 0.1 : 0.12)), dark }
  }
  const ACC = ['info', 'warn', 'brand', 'bad']                  // calm → amber → orange → red, all theme colours
  const inkFrom = (base, P) => ({ hot:mix(base, '#ffffff', 0.45), c0:mix(base, base, 0), c1:mix(base, P.dark ? '#000000' : '#ffffff', 0.35) })
  const rgb01 = (h) => mix(h, h, 0)

  /* ---------- the variants ---------- */
  const d = S.api, p = pctOf(d), nm = nextMark(p), away = fmtK(WIN * nm.p / 100 - d.used), acc = ACC[crossed(p)]
  const s = d.save, sp = d.split, est = money(usd(total(d), d)), spent = money(d.usd.spent)
  const btns = (prim) => [{ btn:'Clear', key:'c', kind:prim === 'c' ? 'primary' : 'secondary' }, { t:'  ' }, { btn:'Compact', key:'k', kind:'secondary' }, { t:'  ' }, { btn:'Later', key:'l', kind:prim === 'l' ? 'primary' : 'secondary' }]
  /* M4: M2 by default; [e] More adds M3's cache and split bars at the bottom, and swatches tie the list to the split */
  function m4Lines(T, v) {
    const term = T === 'term', more = v.more, sw = (c) => more ? [{ t:'■ ', c }] : [{ t:'  ' }]
    const toggle = { btn:more ? 'Less' : 'More', key:'e', kind:'secondary', act:() => { v.more = !v.more; rebuild() } }
    // closed: the bar, the buttons, and two dim hints by esc: cache warmth (minutes left) and what was saved
    const cacheHint = d.cache.known ? (d.cache.warm ? [{ t:'● ', role:d.cache.left <= 5 ? 'warn' : 'ok' }, { t:`warm ${d.cache.left}m`, role:'faint' }] : [{ t:'○ ', role:'faint' }, { t:'cold', role:'faint' }]) : [{ t:'○ ', role:'faint' }, { t:'cache after 1st reply', role:'faint' }]
    if (!more) return [
      [{ bar:'ctx' }, { t:`  ${p}%`, role:acc, b:true }],
      [...btns('l'), { sp:1 }, ...cacheHint, { t:` · ${fmtK(total(d))} saved`, role:'faint' }, { t:'  ' }, toggle, { t:'  esc', role:'faint' }],
    ]
    return [
      [{ t:`${fmtK(total(d))} tokens saved`, role:'text', b:true }, { t:' this session', role:'faint' }, { sp:1 }, { t:`≈ ${est}`, role:'dim' }, { t:' est · spent ', role:'faint' }, { t:spent, role:'dim' }],
      [{ bar:'ctx' }, { t:term ? `  ${p}%` : `  ${fmtK(d.used)} / ${fmtK(WIN)}`, role:term ? acc : 'dim', b:term }],
      [{ t:term ? `${nm.id} at ${nm.p}% · ${away} to go` : `${p}%`, role:term ? 'dim' : acc, b:!term }, ...(term ? [] : [{ t:` · ${nm.id} at ${nm.p}%, ${away} to go`, role:'faint' }]), { sp:1 }, { t:'● ', role:'ok' }, { t:'cache warm', role:'dim' }, { t:` · ${d.cache.left} min · ${d.cache.hit}% hit`, role:'faint' }],
      [{ blank:1 }],
      [{ t:fmtK(s.cacheSaved), role:'text', b:true, col:6 }, { t:'  ' }, { t:'Cache reads', role:'dim', lab:16 }, { t:'billed at a tenth', role:'faint' }],
      [{ t:fmtK(s.keptOut), role:'text', b:true, col:6 }, { t:'  ' }, { t:'Trimmed output', role:'dim', lab:16 }, { t:`kept out of ${s.keptTurns} turns`, role:'faint' }],
      [{ t:fmtK(s.vetoTok), role:'text', b:true, col:6 }, { t:'  ' }, { t:'Re-cache saved', role:'dim', lab:16 }, { t:`${plural(s.vetoes, 'cold compaction')} blocked`, role:'faint' }],
      [{ t:fmtK(d.month.tok), role:'text', b:true, col:6 }, { t:'  ' }, { t:d.month.name, role:'dim', lab:16 }, { t:`≈ ${money(usd(d.month.tok, d))} at ${money(d.usd.rate)}/M`, role:'faint' }],
      [{ blank:1 }],
      [{ t:'Every turn re-sends', role:'faint' }],
      [{ t:fmtK(sp.mcp), role:'text', b:true, col:6 }, { t:'  ' }, ...sw('mcp'), { t:'MCP tools', role:'dim', lab:14 }, { t:'/mcp', role:'brand' }, { t:'  turn off servers you don’t use', role:'faint' }],
      [{ t:fmtK(sp.messages), role:'text', b:true, col:6 }, { t:'  ' }, ...sw('messages'), { t:'Conversation', role:'dim', lab:14 }, { t:'Clear', role:'brand' }, { t:'  when the topic changes', role:'faint' }],
      [{ t:fmtK(sp.skills), role:'text', b:true, col:6 }, { t:'  ' }, ...sw('skills'), { t:'Skills', role:'dim', lab:14 }, { t:'/loadout', role:'brand' }, { t:'  park the ones you never call', role:'faint' }],
      ...(more ? [
        [{ blank:1 }],
        [{ t:'cache', role:'faint', lab:8 }, { bar:'cache' }, { t:'  ', role:'faint' }, { t:`${d.cache.left}m`, role:'ok', b:true }, { t:term ? ` of ${d.cache.ttl}` : ` left of ${d.cache.ttl} · ${d.cache.hit}% hit`, role:'faint' }],
        [{ t:'context', role:'faint', lab:8 }, { bar:'split' }, { t:'  ', role:'faint' }, { t:fmtK(d.used), role:'dim', b:true }, { t:` of ${fmtK(WIN)}`, role:'faint' }],
      ] : []),
      [{ blank:1 }],
      [...btns('l'), { sp:1 }, toggle, { t:'  esc', role:'faint' }],
    ]
  }
  const ROLE_OF = { b:'text', d:'faint', n:'dim', warm:'ok', cold:'faint', key:'faint', arrow:'faint', sw:'dim' }
  const VARIANTS = [
    {
      id:'M4', name:'Picked: closed is just the bar and the buttons; [e] More opens M2 with the cache and split bars', more:false, why:[
        'Closed, the pane is two rows: the context bar with its percentage in the threshold colour, then Clear, Compact, Later and, by esc, two dim hints and [e] More. The hints are the cache (● warm 47m, ○ cold) and "2.2M saved". The cache dot turns amber in the last 5 minutes. Cache size is not shown: the cached prefix is what the bar already shows.',
        '[e] More opens M2 in full: savings on row 1, the bar, context and cache status, the ledger in columns, and "Every turn re-sends" with commands in Claude orange. M3\u2019s two bars sit at the bottom: the cache draining in success green, and the context split in category colours, with swatches tying each "re-sends" row to its segment.',
        'The buttons stay on the last row in both states, so c, k, l and e never move. [e] Less closes the pane back to two rows.',
        'The button works in this frame. Click More or Less.',
      ],
      lines:(T, v) => m4Lines(T, v),
    },
    {
      id:'M4', name:'The same pane after [e] More', more:true, why:['Shown open, so the two states can be compared without clicking.'],
      lines:(T, v) => m4Lines(T, v),
    },
    {
      id:'M1', name:'Baseline', why:[
        'The expanded pane as it stands, recoloured with theme roles only, for comparison.',
        'The first row packs three clusters (savings, context, cache). The ledger labels mix "from cache", "trimmed" and "vetoed" with run-on detail. There are three bars.',
      ],
      lines:(T) => expanded(d, 'api', T === 'term' ? 'term' : 'desk').map((L) => L.map((g) => g.bar ? g : g.btn ? g : g.blank ? g : g.sp ? g : { ...g, role:g.st === 'b' ? 'text' : ROLE_OF[g.st] || 'dim', b:g.st === 'b' })),
    },
    {
      id:'M2', name:'Calm: one bar, plain words', why:[
        'Row 1 is the answer and nothing else: "2.2M tokens saved", with the estimate and the real spend on the right.',
        'There is one bar, the context bar. The percentage is drawn in the threshold colour, so the number and the bar raise the same alarm. Cache becomes one line of status text, not a second bar.',
        'The ledger is set in three columns: number, plain name ("Cache reads", "Trimmed output"), detail. You read down the names, not along sentences.',
        '"Every turn re-sends" replaces the split bar and its swatches. Commands are drawn in Claude orange, the colour Claude Code uses for itself, so they read as things to type.',
      ],
      lines:(T) => {
        const term = T === 'term'
        return [
          [{ t:`${fmtK(total(d))} tokens saved`, role:'text', b:true }, { t:' this session', role:'faint' }, { sp:1 }, { t:`≈ ${est}`, role:'dim' }, { t:' est · spent ', role:'faint' }, { t:spent, role:'dim' }],
          [{ bar:'ctx' }, { t:term ? `  ${p}%` : `  ${fmtK(d.used)} / ${fmtK(WIN)}`, role:term ? acc : 'dim', b:term }],
          [{ t:term ? `${nm.id} at ${nm.p}% · ${away} to go` : `${p}%`, role:term ? 'dim' : acc, b:!term }, ...(term ? [] : [{ t:` · ${nm.id} at ${nm.p}%, ${away} to go`, role:'faint' }]), { sp:1 }, { t:'● ', role:'ok' }, { t:'cache warm', role:'dim' }, { t:` · ${d.cache.left} min · ${d.cache.hit}% hit`, role:'faint' }],
          [{ blank:1 }],
          [{ t:fmtK(s.cacheSaved), role:'text', b:true, col:6 }, { t:'  ' }, { t:'Cache reads', role:'dim', lab:16 }, { t:'billed at a tenth', role:'faint' }],
          [{ t:fmtK(s.keptOut), role:'text', b:true, col:6 }, { t:'  ' }, { t:'Trimmed output', role:'dim', lab:16 }, { t:`kept out of ${s.keptTurns} turns`, role:'faint' }],
          [{ t:fmtK(s.vetoTok), role:'text', b:true, col:6 }, { t:'  ' }, { t:'Re-cache saved', role:'dim', lab:16 }, { t:`${plural(s.vetoes, 'cold compaction')} blocked`, role:'faint' }],
          [{ t:fmtK(d.month.tok), role:'text', b:true, col:6 }, { t:'  ' }, { t:d.month.name, role:'dim', lab:16 }, { t:`≈ ${money(usd(d.month.tok, d))} at ${money(d.usd.rate)}/M`, role:'faint' }],
          [{ blank:1 }],
          [{ t:'Every turn re-sends', role:'faint' }],
          [{ t:fmtK(sp.mcp), role:'text', b:true, col:6 }, { t:'  ' }, { t:'MCP tools', role:'dim', lab:16 }, { t:'/mcp', role:'brand' }, { t:'  turn off servers you don’t use', role:'faint' }],
          [{ t:fmtK(sp.messages), role:'text', b:true, col:6 }, { t:'  ' }, { t:'Conversation', role:'dim', lab:16 }, { t:'Clear', role:'brand' }, { t:'  when the topic changes', role:'faint' }],
          [{ t:fmtK(sp.skills), role:'text', b:true, col:6 }, { t:'  ' }, { t:'Skills', role:'dim', lab:16 }, { t:'/loadout', role:'brand' }, { t:'  park the ones you never call', role:'faint' }],
          [{ blank:1 }],
          [...btns('l'), { sp:1 }, { t:'e less · esc', role:'faint' }],
        ]
      },
    },
    {
      id:'M3', name:'Compact: bars carry it', why:[
        'For people who read bars before words. There are three bars, all in theme colours: context in the threshold colour, cache in success green, and the split in category colours.',
        'The ledger fits on one line ("cache 1.7M · trimming 412k · vetoes 88k") with October on the right, so the pane is 4 rows shorter than M1.',
        'The next step is a sentence in the threshold colour, just above the buttons it leads to.',
      ],
      lines:(T) => {
        const term = T === 'term'
        return [
          [{ t:`${fmtK(total(d))} tokens saved`, role:'text', b:true }, { sp:1 }, { t:`≈ ${est}`, role:'dim' }, { t:' est · spent ', role:'faint' }, { t:spent, role:'dim' }],
          [{ t:term ? 'cache ' : 'by  ', role:'faint' }, ...(term ? [{ t:fmtK(s.cacheSaved), role:'text', b:true }, { t:' · trim ', role:'faint' }] : [{ t:'cache ', role:'faint' }, { t:fmtK(s.cacheSaved), role:'text', b:true }, { t:' · trimming ', role:'faint' }]), { t:fmtK(s.keptOut), role:'text', b:true }, { t:term ? ' · veto ' : ' · vetoes ', role:'faint' }, { t:fmtK(s.vetoTok), role:'text', b:true }, { sp:1 }, { t:term ? 'Oct ' : `${d.month.name} `, role:'faint' }, { t:fmtK(d.month.tok), role:'dim', b:true }],
          [{ blank:1 }],
          [{ t:'context', role:'faint', lab:9 }, { bar:'ctx' }, { t:`  ${p}%`, role:acc, b:true }],
          [{ t:'cache', role:'faint', lab:9 }, { bar:'cache' }, { t:`  ${d.cache.left}m`, role:'ok', b:true }],
          [{ t:'split', role:'faint', lab:9 }, { bar:'split' }, { t:`  ${fmtK(d.used)}`, role:'dim' }],
          [{ t:'', role:'faint', lab:9 }, { t:'■ ', c:'mcp' }, { t:`MCP ${fmtK(sp.mcp)}`, role:'dim' }, { t:' /mcp', role:'brand' }, { t:'   ' }, { t:'■ ', c:'messages' }, { t:`chat ${fmtK(sp.messages)}`, role:'dim' }, { t:' Clear', role:'brand' }, { t:'   ' }, { t:'■ ', c:'skills' }, { t:`skills ${fmtK(sp.skills)}`, role:'dim' }, { t:' /loadout', role:'brand' }],
          [{ blank:1 }],
          [{ t:`${nm.id[0].toUpperCase() + nm.id.slice(1)} at ${nm.p}%, ${away} to go: `, role:acc, b:true }, { t:term ? 'write one, then Clear.' : 'write a handoff, then Clear.', role:'dim' }],
          [...btns('l'), { sp:1 }, { t:'e less · esc', role:'faint' }],
        ]
      },
    },
  ]

  /* ---------- ten closed layouts for M4: the bar row never changes; actions, hints and the e chevron move ---------- */
  const LAYOUTS = (() => {
    const left = d.cache.left
    const dot = () => [{ t:'● ', role:left <= 5 ? 'warn' : 'ok' }, { t:`warm ${left}m`, role:'faint' }]
    const saved = () => ({ t:`${fmtK(total(d))} saved`, role:'faint' })
    const hints = () => [...dot(), { t:' · ', role:'faint' }, saved()]
    const B = (key, label, kind = 'secondary', x = {}) => ({ btn:label, key, kind, ...x })
    const chev = (lv, x = {}) => ({ btn:lv.open ? '▴' : '▾', key:'e', kind:'chev', label:lv.open ? 'Less' : 'More', act:() => { lv.open = !lv.open; rebuild() }, ...x })
    const barRow = () => [{ bar:'ctx' }, { t:`  ${p}%`, role:acc, b:true }]
    const gap = (n = 2) => ({ t:' '.repeat(n) })
    const escT = { t:'esc', role:'faint' }
    const ctx = { t:'Context', role:'faint' }
    const title3 = (T, ...mid) => [ctx, ...(mid.length ? [{ t:'   ' }, ...mid] : []), { sp:1 }, ...(T === 'term' ? [] : [escT])]
    const std = (prim = 'l') => [B('c', 'Clear', prim === 'c' ? 'primary' : 'secondary'), gap(), B('k', 'Compact', prim === 'k' ? 'primary' : 'secondary'), gap(), B('l', 'Later', prim === 'l' ? 'primary' : 'secondary')]
    const plain = () => [B('c', 'Clear', 'plain'), gap(), B('k', 'Compact', 'plain'), gap(), B('l', 'Later', 'plain')]
    return [
      { id:'L1', name:'Split rail', why:'The chevron sits at the end of the bar it opens. The hints go under the bar on the left, where the eye lands after the percentage. Actions are right-aligned, with Later as the default.',
        lines:(T, lv) => [[...barRow(), gap(), chev(lv)], [...hints(), { sp:1 }, ...std()]] },
      { id:'L2', name:'One line', why:'The whole pane is a single row: bar, percentage, three plain actions, chevron. The hints move into the title bar next to "Context". This is the smallest the pane gets with the labels kept.',
        title:(T) => title3(T, ...hints()),
        lines:(T, lv) => [[...barRow(), gap(3), ...plain(), gap(), chev(lv)]] },
      { id:'L3', name:'Segmented control', why:'Clear, Compact and Later become one joined control, which reads as a single decision with three answers. The hints and chevron sit together on the right.',
        lines:(T, lv) => [barRow(), [B('c', 'Clear', 'seg', { first:true }), B('k', 'Compact', 'seg'), B('l', 'Later', 'seg', { last:true, hot:true }), { sp:1 }, ...hints(), gap(), chev(lv)]] },
      { id:'L4', name:'One recommended action', why:'The pane recommends one action, here Later, and shows it as the only button. The other two are quiet text links. When you pass a threshold the recommended action changes: Clear past handoff, Compact while warm past compact.',
        lines:(T, lv) => [barRow(), [B('l', 'Later', 'primary'), { t:'  or  ', role:'faint' }, B('c', 'clear', 'ghost'), { t:' · ', role:'faint' }, B('k', 'compact', 'ghost'), { sp:1 }, ...hints(), gap(), chev(lv)]] },
      { id:'L5', name:'Chevron in the title', why:'The title bar holds the status (cache dot, saved) and the chevron, next to esc. The body is just the bar and the three actions, so it reads as content, not chrome.',
        title:(T, lv) => [ctx, { t:'   ' }, ...hints(), { sp:1 }, chev(lv, { quiet:true }), ...(T === 'term' ? [] : [gap(), escT])],
        lines:(T, lv) => [barRow(), std()] },
      { id:'L6', name:'Drawer handle', why:'A centred handle under the actions opens the pane like a drawer. It is easy to find and hit, and it says "there is more below" without a word. Actions sit on the left, status on the right.',
        lines:(T, lv) => [barRow(), [...std(), { sp:1 }, ...hints()], [{ handle:chev(lv, { quiet:true }) }]] },
      { id:'L7', name:'Status chips', why:'The three things worth knowing become chips: cache, saved, and the next mark in the threshold colour. Plain actions and the chevron sit on the right. It scans like a dashboard strip.',
        lines:(T, lv) => [barRow(), [{ chip:dot() }, gap(1), { chip:[saved()] }, gap(1), { chip:[{ t:`${nm.id} ${nm.p}%`, role:acc }] }, { sp:1 }, ...plain(), gap(), chev(lv)]] },
      { id:'L8', name:'Next step first', why:'The second row leads with what is coming, "Handoff at 60% · 24k to go", in the threshold colour, followed by the buttons that act on it. The quiet status moves to the title.',
        title:(T) => title3(T, ...hints()),
        lines:(T, lv) => [barRow(), [{ t:`${nm.id[0].toUpperCase() + nm.id.slice(1)} at ${nm.p}%`, role:acc, b:true }, { t:` · ${away} to go`, role:'faint' }, { sp:1 }, ...std(), gap(), chev(lv)]] },
      { id:'L9', name:'Keycap rail', why:'One row: the bar, then the hotkeys themselves as keycaps (c, k, l), with labels on hover. This is the densest layout, for people who already know the keys. Status goes in the title.',
        title:(T) => title3(T, ...hints()),
        lines:(T, lv) => [[...barRow(), { t:'  │  ', role:'faint' }, B('c', 'Clear', 'key'), gap(1), B('k', 'Compact', 'key'), gap(1), B('l', 'Later', 'key'), gap(), chev(lv)]] },
      { id:'L10', name:'Ghost', why:'No button chrome at all. The actions are text, with the hotkey in Claude orange, and the chevron is faint. The bar is the only solid thing in the pane, so the eye goes there first.',
        lines:(T, lv) => [barRow(), [B('c', 'clear', 'ghost'), gap(3), B('k', 'compact', 'ghost'), gap(3), B('l', 'later', 'ghost'), { sp:1 }, ...hints(), gap(3), chev(lv, { quiet:true })]] },
    ].map((lv) => ({ ...lv, open:false }))
  })()
  /* opening any layout adds M4's open body under the bar row: status, savings, re-sends, cache and split bars */
  function openBody(T) {
    const L = m4Lines(T, { more:true })
    // the bar row above already carries the percentage: the status row starts at the next mark instead
    const status = L[2][0].t === `${p}%` ? [{ ...L[2][1], t:L[2][1].t.replace(/^ · /, '') }, ...L[2].slice(2)] : L[2]
    return [status, [{ blank:1 }], L[0], ...L.slice(4, L.length - 2)]
  }
  function layoutLines(lv, T) {
    const lines = lv.lines(T, lv)
    if (!lv.open) return lines
    const at = lines.findIndex((L) => L.some((g) => g.bar === 'ctx')) + 1
    return [...lines.slice(0, at), [{ blank:1 }], ...openBody(T), [{ blank:1 }], ...lines.slice(at)]
  }

  /* ---------- drawing ---------- */
  const TW = 76
  const CATS = { mcp:'brand', messages:'info', skills:'ok', tools:'faint', system:'faint', memory:'faint' }
  /* Controls come in kinds: primary / secondary (bordered), plain (keycap + label, no border), ghost (text only),
     key (a lone keycap, label on hover), seg (one joined segmented control), chev (the e toggle, ▾ / ▴) */
  const segText = (g) => {
    if (g.btn) {
      if (g.kind === 'chev') return g.noKey ? g.btn : `e ${g.btn}`
      if (g.kind === 'pill') return `[ ${g.btn} ]`
      if (g.kind === 'plain' || g.kind === 'ghost') return `${g.key} ${g.btn}`
      if (g.kind === 'key') return `[${g.key}]`
      if (g.kind === 'seg') return `${g.first ? '[' : ''}${g.key} ${g.btn}${g.last ? ']' : ' │ '}`
      return `[${g.key}] ${g.btn}`
    }
    if (g.chip) return `(${g.chip.map(segText).join('')})`
    return g.col ? String(g.t).padStart(g.col) : g.lab ? String(g.t).padEnd(g.lab) : (g.t || '')
  }
  const colorOf = (g, P) => g.c ? (CATS[g.c] ? P[CATS[g.c]] : g.c) : P[g.role || "dim"]
  function deskRow(segs, P) {
    const row = document.createElement('div'); row.className = 'ml'
    if (segs[0] && segs[0].blank) { row.style.minHeight = '10px'; return row }
    for (const g of segs) {
      if (g.sp) { const x = document.createElement('span'); x.style.flex = '1'; row.append(x); continue }
      if (g.bar) { const x = document.createElement('span'); x.className = 'mbar'; x.innerHTML = '<canvas></canvas>'; x.__bar = g.bar === 'ctx' || g.bar.kind === 'ctx' ? 'ctx' : g.bar.kind || g.bar; row.append(x); continue }
      if (g.chip) {
        const c = document.createElement('span')
        c.style.cssText = `border:1px solid ${P.line};border-radius:10px;padding:0 8px;margin-right:6px;line-height:20px;display:inline-flex`
        for (const x of deskRow(g.chip, P).childNodes) c.append(x.cloneNode(true))
        row.append(c); continue
      }
      if (g.btn && g.kind && !['primary', 'secondary', 'off'].includes(g.kind)) {
        const b = document.createElement('span'); b.className = 'mbtn'; b.title = `${g.label || g.btn} (${g.key})`
        if (g.act) { b.style.cursor = 'pointer'; b.onclick = g.act }
        if (g.kind === 'pill') {
          // the desktop app's own button ("Commit changes"): raised fill, no border, rounded, no keycap, a little smaller
          const fill = P.dark ? P.raised : hex(mix(P.bg, P.text, 0.07))
          b.style.cssText += `;height:22px;padding:0 9px;border-radius:7px;border-color:transparent;margin-right:0;` +
            (g.off ? `background:transparent;color:${P.faint}` : `background:${g.prim ? hex(mix(fill, P.text, 0.12)) : fill};color:${P.text};${g.prim ? 'font-weight:600' : ''}`)
          b.textContent = g.btn
        } else if (g.kind === 'chev') {
          b.style.cssText += `;width:26px;justify-content:center;padding:0;color:${g.quiet ? P.faint : P.text};border-color:${g.quiet ? 'transparent' : P.line}`
          b.innerHTML = `<svg width="12" height="12" viewBox="0 0 12 12"><path d="${g.btn === '▴' ? 'M2.5 7.5 6 4l3.5 3.5' : 'M2.5 4.5 6 8l3.5-3.5'}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`   // the desktop surface has Svg
        } else if (g.kind === 'plain') {
          b.style.cssText += `;border-color:transparent;padding:0 6px;color:${P.dim}`
          b.innerHTML = `<kbd style="color:${P.faint};border-color:${P.line}">${g.key}</kbd>${g.btn}`
        } else if (g.kind === 'ghost') {
          b.style.cssText += `;border-color:transparent;padding:0 4px;color:${P.faint}`
          b.innerHTML = `<span style="color:${P.brand};font-weight:600">${g.key}</span>&nbsp;${g.btn}`
        } else if (g.kind === 'key') {
          b.style.cssText += `;width:26px;justify-content:center;padding:0;color:${P.text};border-color:${P.line};font:600 12px ui-monospace,Menlo,monospace`
          b.textContent = g.key
        } else if (g.kind === 'seg') {
          b.style.cssText += `;color:${P.text};border-color:${P.line};margin:0;border-radius:${g.first ? '6px 0 0 6px' : g.last ? '0 6px 6px 0' : '0'};${g.first ? '' : 'border-left:none'};${g.hot ? `background:${P.text};color:${P.bg};font-weight:600` : ''}`
          b.innerHTML = `<kbd style="color:${g.hot ? P.bg : P.faint};border-color:${g.hot ? P.bg : P.line}">${g.key}</kbd>${g.btn}`
        }
        row.append(b); continue
      }
      if (g.handle) {
        row.style.justifyContent = 'center'
        const line = () => { const x = document.createElement('span'); x.style.cssText = `flex:1;height:1px;background:${P.line};margin:0 10px`; return x }
        row.append(line()); row.append(deskRow([g.handle], P).firstChild); row.append(line()); continue
      }
      if (g.btn) {
        const b = document.createElement('span'); b.className = 'mbtn'
        const prim = g.kind === 'primary'
        b.style.cssText = prim ? `background:${P.text};color:${P.bg};border-color:${P.text};font-weight:600` : g.kind === 'off' ? `color:${P.faint};border-style:dashed;border-color:${P.line}` : `color:${P.text};border-color:${P.line}`
        if (g.act) { b.style.cursor = 'pointer'; b.onclick = g.act }
        b.innerHTML = `<kbd style="color:${prim ? P.bg : P.faint};border-color:${prim ? P.bg : P.line}">${g.key}</kbd>${g.btn}`
        row.append(b); continue
      }
      const x = document.createElement('span'); x.textContent = g.t
      x.style.color = colorOf(g, P); if (g.b) x.style.fontWeight = '650'
      if (g.col) { x.style.cssText += ';display:inline-block;width:7%;text-align:right;padding-right:6px' }
      if (g.lab) { x.style.cssText += `;display:inline-block;flex:none;width:${g.lab * 0.6}em` }
      row.append(x)
    }
    return row
  }
  function termCtl(g, P) {
    const t = segText(g)
    if (g.chip) return `<span style="color:${P.faint}">(</span>${g.chip.map((x) => `<span style="color:${colorOf(x, P)}">${esc(segText(x))}</span>`).join('')}<span style="color:${P.faint}">)</span>`
    if (g.kind === 'pill') return `<span style="color:${g.off ? P.faint : g.prim ? P.text : P.dim}${g.prim ? ';font-weight:700' : ''}">${esc(t)}</span>`
    if (g.kind === 'chev' && g.noKey) return `<span style="color:${g.quiet ? P.faint : P.text};font-weight:700">${g.btn}</span>`
    if (g.kind === 'chev') return `<span style="color:${P.faint}">e </span><span style="color:${g.quiet ? P.faint : P.text};font-weight:700">${g.btn}</span>`
    if (g.kind === 'plain') return `<span style="color:${P.brand};font-weight:700">${g.key}</span><span style="color:${P.dim}"> ${esc(g.btn)}</span>`
    if (g.kind === 'ghost') return `<span style="color:${P.brand}">${g.key}</span><span style="color:${P.faint}"> ${esc(g.btn)}</span>`
    if (g.kind === 'key') return `<span style="color:${P.text}">${esc(t)}</span>`
    if (g.kind === 'seg') return `${g.first ? `<span style="color:${P.faint}">[</span>` : ''}<span style="${g.hot ? `background:${P.text};color:${P.bg};font-weight:700` : `color:${P.brand};font-weight:700`}">${g.key}</span><span style="${g.hot ? `background:${P.text};color:${P.bg};font-weight:700` : `color:${P.text}`}"> ${esc(g.btn)}</span><span style="color:${P.faint}">${g.last ? ']' : ' │ '}</span>`
    return null
  }
  function termRow(segs, P) {
    if (segs[0] && segs[0].blank) return { html:'', len:0, bars:[] }
    if (segs[0] && segs[0].handle) {
      const mid = ` ${segText(segs[0].handle)} `, side = Math.floor((TW - mid.length) / 2)
      return { html:`<span style="color:${P.line}">${'─'.repeat(side)}</span>${termCtl(segs[0].handle, P).replace(/^/, ' ')} <span style="color:${P.line}">${'─'.repeat(TW - side - mid.length)}</span>`, len:TW, bars:[] }
    }
    let fixed = 0; for (const g of segs) if (!g.sp && !g.bar) fixed += segText(g).length
    const rem = Math.max(0, TW - fixed); let html = '', bars = []
    for (const g of segs) {
      if (g.sp) { html += ' '.repeat(rem); continue }
      if (g.bar) { const id = 'tb' + Math.random().toString(36).slice(2); bars.push({ id, kind:g.bar === 'ctx' || g.bar.kind === 'ctx' ? 'ctx' : g.bar.kind || g.bar, cols:rem }); html += `<span id="${id}"></span>`; continue }
      const t = segText(g)
      const ctl = (g.btn || g.chip) ? termCtl(g, P) : null
      if (ctl) { html += ctl; continue }
      if (g.btn) { const prim = g.kind === 'primary'; html += `<span style="${prim ? `background:${P.text};color:${P.bg};font-weight:700` : `color:${P.text}`}">${esc(t)}</span>`; continue }
      html += `<span style="color:${colorOf(g, P)}${g.b ? ';font-weight:700' : ''}">${esc(t)}</span>`
    }
    const len = fixed + (segs.some((g) => g.sp || g.bar) ? rem : 0)
    return { html:html + ' '.repeat(Math.max(0, TW - len)), len, bars }
  }

  /* bars in theme: F1 for context (inks from the theme's threshold colour), flat cells for cache and split */
  function barInfoThemed(P, W, geo = {}) {
    const info = barInfo('blue', d.used / WIN, true, W, { seed:31, ...geo })
    info.ink = inkFrom(P[acc], P); info.inkName = 'blue'; info.track = rgb01(P.track)
    return info
  }
  function paintFlat(cv, W, P, parts, scale = 1) {
    const h = 14, pitch = 3.5, half = 0.75 * pitch / 2, dpr = 2
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = h * dpr; cv.style.width = W + 'px'; cv.style.height = h + 'px' }
    const ctx = cv.getContext('2d'); ctx.clearRect(0, 0, cv.width, cv.height)
    ctx.fillStyle = P.track; ctx.beginPath(); ctx.roundRect(0, 0, cv.width, cv.height, 4 * dpr); ctx.fill()
    const cols = Math.ceil(W / pitch)
    for (let cx = 0; cx < cols; cx++) {
      const f = (cx + 0.5) / cols; let acc2 = 0, col = null
      for (const pt of parts) { acc2 += pt.f; if (f < acc2) { col = pt.color; break } }
      if (!col) continue
      for (let cy = 0; cy < 4; cy++) { ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect(((cx + 0.5) * pitch - half) * dpr, ((cy + 0.5) * pitch - half) * dpr, half * 2 * dpr, half * 2 * dpr, 0.9 * dpr); ctx.fill() }
    }
  }
  const flatParts = (kind, P) => kind === 'cache'
    ? [{ f:d.cache.left / d.cache.ttl, color:P.ok }]
    : [['system', 'faint', 0.55], ['tools', 'faint', 0.55], ['memory', 'faint', 0.55], ['skills', 'ok', 1], ['mcp', 'brand', 1], ['messages', 'info', 1]].map(([k, r, a]) => ({ f:sp[k] / WIN, color:a < 1 ? hex(mix(P[r], P.track, 0.45)) : P[r] }))
  function rasterHTML(info, P, opt, t, kind) {
    if (kind !== 'ctx') {
      const parts = flatParts(kind, P), out = []
      for (let cx = 0; cx < info.cols; cx++) { const f = (cx + 0.5) / info.cols; let a = 0, c = P.track; for (const pt of parts) { a += pt.f; if (f < a) { c = pt.color; break } } out.push(`<span style="color:${c};background:${c}">▀</span>`) }
      return out.join('')
    }
    const r = runOpt(opt, info, t), out = []
    for (let cx = 0; cx < info.cols; cx++) {
      let a = null, b = null; try { a = r.shade(cx, 0); b = r.shade(cx, 1) } catch {}
      out.push(`<span style="color:${a ? rgbHex(a) : P.track};background:${b ? rgbHex(b) : P.track}">▀</span>`)
    }
    return out.join('')
  }

  /* ---------- the board ---------- */
  const STATE = { desk:localStorage.midDesk || 'dark', term:localStorage.midTerm || 'dark' }
  const host = document.getElementById('mid'), ctl = document.getElementById('midctl')
  const views = []
  let rebuild = () => {}
  const ctx0 = { t:'Context', role:'faint' }
  function build() {
    rebuild = build
    const PD = palette('desktop', STATE.desk), PT = palette('cli', STATE.term)
    ctl.innerHTML = `
      <div class="grp">Desktop ${['dark', 'light'].map((k) => `<button data-desk="${k}" class="${STATE.desk === k ? 'on' : ''}">${k}</button>`).join(' ')}</div>
      <div class="grp">Terminal ${['dark', 'light', 'dark-daltonized', 'light-daltonized'].map((k) => `<button data-term="${k}" class="${STATE.term === k ? 'on' : ''}">${k}</button>`).join(' ')}</div>`
    ctl.querySelectorAll('[data-desk]').forEach((b) => { b.onclick = () => { STATE.desk = localStorage.midDesk = b.dataset.desk; build() } })
    ctl.querySelectorAll('[data-term]').forEach((b) => { b.onclick = () => { STATE.term = localStorage.midTerm = b.dataset.term; build() } })
    host.innerHTML = ''; views.length = 0
    for (const v of VARIANTS) {
      const wrap = document.createElement('div'); wrap.className = 'mvar'
      wrap.innerHTML = `<div class="mhead"><span class="mid">${v.id}</span><b>${esc(v.name)}</b></div><ul class="mwhy">${v.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
      const pair = document.createElement('div'); pair.className = 'pair'
      /* desktop */
      const dcol = document.createElement('div'); dcol.className = 'col'
      dcol.innerHTML = `<div class="frame-label"><b>Desktop</b> · 860 px · ${PD.name}</div>`
      const pane = document.createElement('div'); pane.className = 'mpane'
      pane.style.cssText = `background:${PD.bg};border-color:${PD.line};color:${PD.dim}`
      pane.innerHTML = `<div class="ml" style="color:${PD.faint};margin-bottom:8px"><span>Context</span><span style="flex:1"></span><span>esc</span></div>`
      for (const L of v.lines('desk', v)) pane.append(deskRow(L, PD))
      dcol.append(pane); pair.append(dcol)
      /* terminal */
      const tcol = document.createElement('div'); tcol.className = 'col'
      tcol.innerHTML = `<div class="frame-label"><b>Terminal</b> · 80 columns · ${PT.name}</div>`
      const tf = document.createElement('div'); tf.className = 'mterm'; tf.style.cssText = `background:${PT.bg};border-color:${PT.line}`
      const bars = []; let over = 0
      const top = `╭─ Context `
      let html = `<div style="color:${PT.line}">${top}${'─'.repeat(79 - top.length)}╮</div>`
      for (const L of v.lines('term', v)) { const r = termRow(L, PT); if (r.len > TW) over++; bars.push(...r.bars); html += `<div${r.len > TW ? ' class="overflow"' : ''}><span style="color:${PT.line}">│ </span>${r.html}<span style="color:${PT.line}"> │</span></div>` }
      html += `<div style="color:${PT.line}">╰${'─'.repeat(78)}╯</div>`
      tf.innerHTML = `<pre>${html}</pre>`; tcol.append(tf)
      if (over) tcol.insertAdjacentHTML('beforeend', `<div class="warnbox">${over} line(s) over 76 cells</div>`)
      pair.append(tcol); wrap.append(pair); host.append(wrap)
      views.push({ pane, PD, PT, tbars:bars.map((b) => ({ ...b, el:tf.querySelector('#' + b.id) })) })
    }
    /* roles table */
    const tbl = document.createElement('div'); tbl.className = 'mvar'
    tbl.innerHTML = `<div class="mhead"><b>Colour roles → theme</b></div>
      <p class="mnote">A mod's <code>Text color</code> takes a theme key or a raw colour. Name the <b>CLI theme key</b> and the engine resolves it for whatever theme the person runs, including light and the colour-blind (daltonized) themes. The desktop column is the Claude app's own token for the same role, which the desktop frames use. Bars are drawn cells, so they take colours resolved from the same roles.</p>
      <table class="strings mroles"><tr><th>Role</th><th>Used for</th><th>CLI theme key</th><th>${esc(PT.name)}</th><th>Desktop token</th><th>${esc(PD.name)}</th></tr>
      ${ROLE_KEYS.map(([r, use, key, tok]) => `<tr><td class="k">${r}</td><td>${use}</td><td><code>${key}</code></td><td><i class="msw" style="background:${PT[r]}"></i><code>${PT[r]}</code></td><td><code>${tok}</code></td><td><i class="msw" style="background:${PD[r]}"></i><code>${PD[r]}</code></td></tr>`).join('')}
      <tr><td class="k">surface</td><td>pane background</td><td><code>(the terminal's)</code></td><td><i class="msw" style="background:${PT.bg}"></i><code>${PT.bg}</code></td><td><code>bg-100</code></td><td><i class="msw" style="background:${PD.bg}"></i><code>${PD.bg}</code></td></tr>
      <tr><td class="k">track</td><td>empty bar</td><td><code>(mixed from text)</code></td><td><i class="msw" style="background:${PT.track}"></i><code>${PT.track}</code></td><td><code>bg-100 + text-000</code></td><td><i class="msw" style="background:${PD.track}"></i><code>${PD.track}</code></td></tr>
      </table>`
    host.append(tbl)
    const lay = document.getElementById('lay')
    if (lay) {
      lay.innerHTML = ''
      for (const lv of LAYOUTS) {
        const wrap = document.createElement('div'); wrap.className = 'mvar'
        wrap.innerHTML = `<div class="mhead"><span class="mid">${lv.id}</span><b>${esc(lv.name)}</b><span style="color:var(--dim);font-size:12px">${lv.open ? 'open' : 'closed'} · click the chevron</span></div><p class="mwhy" style="padding:0;list-style:none">${esc(lv.why)}</p>`
        const pair = document.createElement('div'); pair.className = 'pair'
        const dcol = document.createElement('div'); dcol.className = 'col'
        dcol.innerHTML = `<div class="frame-label"><b>Desktop</b> · 860 px · ${PD.name}</div>`
        const pane = document.createElement('div'); pane.className = 'mpane'
        pane.style.cssText = `background:${PD.bg};border-color:${PD.line};color:${PD.dim}`
        const tr = deskRow(lv.title ? lv.title('desk', lv) : [ctx0, { sp:1 }, { t:'esc', role:'faint' }], PD); tr.style.marginBottom = '8px'
        pane.append(tr)
        for (const L of layoutLines(lv, 'desk')) pane.append(deskRow(L, PD))
        dcol.append(pane); pair.append(dcol)
        const tcol = document.createElement('div'); tcol.className = 'col'
        tcol.innerHTML = `<div class="frame-label"><b>Terminal</b> · 80 columns · ${PT.name}</div>`
        const tf = document.createElement('div'); tf.className = 'mterm'; tf.style.cssText = `background:${PT.bg};border-color:${PT.line}`
        const bars = []; let over = 0
        /* the title rides in the top border: ╭─ Context · hints ───── e ▾ ─╮ */
        const tsegs = lv.title ? lv.title('term', lv).filter((g) => !g.sp) : [ctx0]
        let tl = 0, th = ''
        for (const g of tsegs) { const t = segText(g); tl += t.length; th += (g.btn ? termCtl(g, PT) : `<span style="color:${colorOf(g, PT)}">${esc(t)}</span>`) }
        const chevAt = tsegs.findIndex((g) => g.kind === 'chev')
        let top
        if (chevAt > 0) {           // keep the chevron at the right end of the border
          const head = tsegs.slice(0, chevAt), tail = tsegs.slice(chevAt)
          const hl = head.reduce((n, g) => n + segText(g).length, 0), tlen = tail.reduce((n, g) => n + segText(g).length, 0)
          const hh = head.map((g) => `<span style="color:${colorOf(g, PT)}">${esc(segText(g))}</span>`).join(''), tt = tail.map((g) => g.btn ? termCtl(g, PT) : esc(segText(g))).join('')
          top = `<span style="color:${PT.line}">╭─ </span>${hh}<span style="color:${PT.line}"> ${'─'.repeat(Math.max(1, 80 - 3 - hl - 2 - tlen - 3))} </span>${tt}<span style="color:${PT.line}"> ─╮</span>`
          if (3 + hl + 1 + Math.max(1, 80 - 3 - hl - 2 - tlen - 3) + 1 + tlen + 3 > 80) over++
        } else {
          top = `<span style="color:${PT.line}">╭─ </span>${th}<span style="color:${PT.line}"> ${'─'.repeat(Math.max(1, 80 - 3 - tl - 2))}╮</span>`
          if (tl > 75) over++
        }
        let html = `<div>${top}</div>`
        for (const L of layoutLines(lv, 'term')) { const r = termRow(L, PT); if (r.len > TW) over++; bars.push(...r.bars); html += `<div${r.len > TW ? ' class="overflow"' : ''}><span style="color:${PT.line}">│ </span>${r.html}<span style="color:${PT.line}"> │</span></div>` }
        html += `<div style="color:${PT.line}">╰${'─'.repeat(78)}╯</div>`
        tf.innerHTML = `<pre>${html}</pre>`; tcol.append(tf)
        if (over) tcol.insertAdjacentHTML('beforeend', `<div class="warnbox">${over} line(s) over 80 columns</div>`)
        pair.append(tcol); wrap.append(pair); lay.append(wrap)
        views.push({ pane, PD, PT, tbars:bars.map((b) => ({ ...b, el:tf.querySelector('#' + b.id) })) })
      }
    }
    for (const v of views) v.pane.querySelectorAll('.mbar').forEach((b) => { b.__P = v.PD })
  }
  function draw(t) {
    const opt = fireOpt()
    for (const v of views) {
      v.pane.querySelectorAll('.mbar').forEach((b) => {
        const W = Math.floor(b.clientWidth); if (!W) return
        const cv = b.firstChild
        if (b.__bar === 'ctx') paintFire(cv, barInfoThemed(v.PD, W), opt, t, { marks:MARKS.map((m) => m.p), auto:AUTO, pct:p, track:v.PD.track, buffer:hex(mix(v.PD.track, v.PD.faint, 0.3)), mark:v.PD.dim, markFaint:v.PD.faint })
        else paintFlat(cv, W, v.PD, flatParts(b.__bar, v.PD))
      })
      for (const tb of v.tbars) if (tb.el) tb.el.innerHTML = rasterHTML(barInfoThemed(v.PT, tb.cols * 8, { rows:2, pitch:8, H:16 }), v.PT, opt, t, tb.kind)
    }
  }
  /* Other pages (m4.html) reuse the renderers: palette, rows, controls, bars, M4's open body, the scenario's numbers */
  const ready = []
  window.MID = {
    palette, deskRow, termRow, termCtl, segText, colorOf, m4Lines, openBody, barInfoThemed, paintFlat, flatParts, rasterHTML, mix, hex,
    TW, data:{ d, p, nm, away, acc, total:total(d) }, onReady:(f) => { if (TH) f(TH); else ready.push(f) },
  }
  fetch('theme/claude-themes.json').then((r) => r.json()).then((j) => {
    TH = j
    if (host) {
      build()
      const sec = document.getElementById('b-mid'); watch(sec)
      DRAWERS.push({ el:sec, draw })
      const laySec = document.getElementById('b-lay'); if (laySec) { watch(laySec); DRAWERS.push({ el:laySec, draw }) }
    }
    for (const f of ready.splice(0)) f(j)
  }).catch((e) => { const msg = `<p class="mnote">Theme tokens need the page served over http (design/theme/claude-themes.json): ${esc(String(e))}</p>`; if (host) host.innerHTML = msg; else document.body.insertAdjacentHTML('beforeend', msg) })
})()
