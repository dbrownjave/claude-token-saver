/**
 * Token-saver mod. In-process plugin of function hooks.
 *
 * Sandbox rules: a hooks module may import only its own files and
 * "claude-code". No node:* imports, no process/env globals. Files go through
 * $.fs, environment through $.env, time through $.clock.
 *
 * VS Code's chat panel runs these hooks but does not draw UI.
 */

const LIMIT = 8000
const HEAD = 2500
const TAIL = 1500
const MINUTE = 60 * 1000
const TTL_SHORT = 5 * MINUTE
const TTL_LONG = 60 * MINUTE
const BAND_TICK = 30 * 1000

const DEFAULT_RULES = [
  { id: 'git-status', pattern: '^git\\s+status\\b', unless: ['-sb', '-s'], replace: 'git status -sb' },
  { id: 'git-log', pattern: '^git\\s+log\\b', unless: ['--oneline'], replace: 'git log --oneline -20' },
  { id: 'git-diff', pattern: '^git\\s+diff\\s*$', replace: 'git diff --stat' },
  { id: 'pytest', pattern: '^pytest\\b', unless: ['-q'], append: ' -q --tb=short' },
  { id: 'npm-test', pattern: '^npm\\s+test\\b', unless: ['--reporter', '-- '], append: ' -- --reporter=dot' },
  { id: 'pnpm-test', pattern: '^pnpm\\s+test\\b', unless: ['--reporter', '-- '], append: ' -- --reporter=dot' },
  { id: 'cargo-test', pattern: '^cargo\\s+test\\b', unless: ['--quiet', '-q'], append: ' --quiet' },
]

const DEFAULT_LEVELS = [
  { id: 'watch', pct: 40, hint: 'note' },
  { id: 'handoff', pct: 60, hint: 'new-conversation' },
  { id: 'compact', pct: 75, hint: 'compact-if-warm' },
]

const KEEP =
  'When compacting, keep: current task, files touched, decisions, failing tests, ' +
  'next steps, exact error messages. Drop: raw tool output, resolved errors, ' +
  'exploratory file reads, repeated logs.'

// Module state. A reload starts these over; nothing here needs to survive one.
let lastUsage = null
let lastStepAt = 0
let savedChars = 0
let rewrites = 0
let vetoes = 0
let rules = DEFAULT_RULES
let levels = DEFAULT_LEVELS
let pythonQuietOn = false
let bandHidden = false
let announcedPct = 0            // highest threshold already toasted this session
// Progress rows above the prompt, driven by the `progress` tool the model calls.
const PROGRESS_TOOL = 'mcp__token-saver__progress'
const progressRows = new Map()  // id -> { id, label, stage, step, total, state, target, shown, note }
let progressTicker = null
const STATE_COLOR = { running: '#8b7cf6', waiting: '#d9a441', failed: '#e5484d', done: '#30a46c' }
const STATE_GLYPH = { running: '●', waiting: '?', failed: '!', done: '✓' }
const SKILLS_PANE = 'loadout'
let skillsData = null           // last `skills.py status --json`
let skillsBusy = false
let skillsMsg = ''               // last action's one-line result, shown in the pane footer

async function readJson($, path) {
  try {
    return JSON.parse(await $.fs.read(path))
  } catch {
    return null
  }
}

/** Home config first, project config overrides it. Missing files are fine. */
async function homeDir($) {
  return (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
}

/** python3, then python (Windows installs often ship only `python`). */
async function runPython($, args, init) {
  let lastErr
  for (const exe of ['python3', 'python']) {
    try {
      return await $.process.run([exe, ...args], init)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

/**
 * One child process, streamed. Tries python3 then python. Yields { stream, text } pieces
 * and finally { code }. Throws before the first piece when neither interpreter starts.
 */
async function* spawnPython($, args, init) {
  let lastErr
  for (const exe of ['python3', 'python']) {
    let yielded = false
    try {
      for await (const piece of $.process.spawn({ argv: [exe, ...args], ...init })) {
        yielded = true
        yield piece
      }
      return
    } catch (err) {
      lastErr = err
      if (yielded) throw err
    }
  }
  throw lastErr
}

async function loadConfig($, cwd) {
  const home = await homeDir($)
  const dirs = []
  if (home) dirs.push(`${home}/.claude/token-saver`)
  if (cwd) dirs.push(`${cwd}/.claude/token-saver`)
  rules = DEFAULT_RULES
  levels = DEFAULT_LEVELS
  for (const dir of dirs) {
    const q = await readJson($, `${dir}/quiet.json`)
    if (q && Array.isArray(q.rewrites) && q.rewrites.length) rules = q.rewrites
    const t = await readJson($, `${dir}/thresholds.json`)
    if (t && Array.isArray(t.levels) && t.levels.length) levels = t.levels
  }
  pythonQuietOn = false
  if (home) {
    const settings = await readJson($, `${home}/.claude/settings.json`)
    pythonQuietOn = !!settings && JSON.stringify(settings.hooks || {}).includes('quiet_bash.py')
  }
}

function quiet(cmd) {
  if (!cmd || /&&|\|\||\||;/.test(cmd)) return null
  if (/\brm\b|\bsudo\b|\bdd\b|\bmkfs\b|>\s|\/dev\//.test(cmd)) return null
  for (const rule of rules) {
    if (rule.enabled === false || !rule.pattern) continue
    let re
    try {
      re = new RegExp(rule.pattern)
    } catch {
      continue
    }
    if (!re.test(cmd)) continue
    if ((rule.unless || []).some((u) => cmd.includes(u))) continue
    const next = rule.replace || (rule.append ? cmd + rule.append : null)
    if (!next || next === cmd) return null
    return { id: rule.id || 'custom', next }
  }
  return null
}

function trim(text) {
  if (typeof text !== 'string' || text.length <= LIMIT) return text
  const dropped = text.length - HEAD - TAIL
  return text.slice(0, HEAD) + `\n…[token-saver trimmed ${dropped} chars]…\n` + text.slice(-TAIL)
}

function fmt(n) {
  if (!n) return '0'
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
  return String(n)
}

function mins(ms) {
  return Math.max(1, Math.round(ms / MINUTE))
}

function sentOf(u) {
  if (!u) return 0
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
}

function hitPct(u) {
  const sent = sentOf(u)
  return sent ? Math.round((100 * ((u && u.cache_read_input_tokens) || 0)) / sent) : 0
}

/** Live context fill from the engine; falls back to the last step's usage. */
async function contextOf($) {
  try {
    const usage = await $.session.usage()
    const c = usage && usage.context
    if (c && typeof c.window === 'number' && c.window > 0) {
      const tokens = typeof c.tokens === 'number' ? c.tokens : sentOf(lastUsage)
      const percent =
        typeof c.percent === 'number' ? c.percent : Math.min(100, Math.round((100 * tokens) / c.window))
      return { tokens, window: c.window, percent }
    }
  } catch {
    /* no session bound (tests) or older engine */
  }
  const tokens = sentOf(lastUsage)
  return { tokens, window: 0, percent: 0 }
}

function cacheClock(now, ttl) {
  if (!lastStepAt) return { known: false, warm: false, idleMs: 0, leftMs: 0 }
  const idleMs = Math.max(0, now - lastStepAt)
  return { known: true, warm: idleMs < ttl, idleMs, leftMs: Math.max(0, ttl - idleMs) }
}

function levelFor(pct) {
  return levels.filter((l) => Number(l.pct) <= pct).sort((a, b) => Number(b.pct) - Number(a.pct))[0]
}

function hintFor(pct, clock) {
  const hit = levelFor(pct)
  if (!hit) return ''
  if (hit.hint === 'note') return `past your ${hit.pct}% (${hit.id}) — note decisions`
  if (hit.hint === 'new-conversation') return `past your ${hit.pct}% (${hit.id}) — /handoff then /clear`
  if (hit.hint === 'compact-if-warm' && clock.warm) {
    return `past your ${hit.pct}% (${hit.id}), cache warm ${mins(clock.leftMs)}m — /compact is cheap`
  }
  if (hit.hint === 'compact-if-warm') {
    return `past your ${hit.pct}% (${hit.id}), cache cold — /handoff then /clear, don't /compact`
  }
  return `past your ${hit.pct}% (${hit.id})`
}

async function refreshSkills($, cwd) {
  skillsBusy = true
  try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
  try {
    const args = [`${$.plugin.root}/scripts/skills.py`, 'status', '--json']
    if (cwd) args.push('--project', cwd)
    const r = await runPython($, args, { timeoutMs: 60_000 })
    if (r.exitCode !== 0) throw new Error((r.stderr || r.stdout || `exit ${r.exitCode}`).trim().split('\n')[0])
    skillsData = JSON.parse(r.stdout)
  } catch (err) {
    skillsData = { error: err && err.message ? err.message : String(err) }
  }
  skillsBusy = false
  try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
}

/** Expand globs, @groups and 'unused' against the last status, so each skill can be its own stage. */
function expandSkillNames(verb, names) {
  if (!skillsData || skillsData.error) return names
  const active = (skillsData.active || []).map((x) => x.name)
  const parked = (skillsData.parked || []).map((x) => x.name)
  const pool = verb === 'park' ? active : verb === 'unlink' ? (skillsData.project_links || []) : parked
  const out = []
  for (const raw of names) {
    let hits
    if (raw === 'unused') hits = (skillsData.unused || []).filter((n) => pool.includes(n))
    else if (raw.startsWith('@')) hits = pool.filter((n) => n.split('-')[0] === raw.slice(1))
    else if (/[*?[]/.test(raw)) {
      const re = new RegExp('^' + raw.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
      hits = pool.filter((n) => re.test(n))
    } else hits = [raw]
    for (const h of hits) if (!out.includes(h)) out.push(h)
  }
  return out
}

const VERB_LABEL = { park: 'Park', unpark: 'Bring back', link: 'Link here', unlink: 'Unlink' }

async function actSkills($, verb, names, cwd) {
  if (skillsBusy) return
  skillsBusy = true
  const list = expandSkillNames(verb, names)
  const total = list.length
  const rowId = 'loadout'
  const label = `${VERB_LABEL[verb] || verb} ${total} skill${total === 1 ? '' : 's'}`
  applyProgress({ id: rowId, label, stage: list[0] || verb, step: 1, total, state: 'running', percent: 0 })
  skillsMsg = `${label}…`
  try { $.ui.status('Progress'); $.ui.invalidate('ui.render') } catch { /* no UI */ }
  let ok = 0
  let skipped = 0
  let summary = ''
  const onLine = (line) => {
    // skills.py --progress prints `>> i/n name ok|skip` as each skill lands; one process, many stages.
    const m = /^>> (\d+)\/(\d+) (\S+) (ok|skip)$/.exec(line.trim())
    if (m) {
      const i = Number(m[1]), n = Number(m[2])
      if (m[4] === 'ok') ok += 1
      else skipped += 1
      applyProgress({ id: rowId, stage: m[3], step: Math.min(i + 1, n), total: n, state: 'running', percent: (i / n) * 100 })
      try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
    } else if (line.trim() && !line.startsWith('  skip')) {
      summary = line.trim().replace(/\s+→\s+\S+$/, '')
    }
  }
  try {
    const args = [`${$.plugin.root}/scripts/skills.py`, verb, ...list, '--no-usage', '--progress']
    if (cwd) args.push('--project', cwd)
    let streamed = false
    try {
      let buf = ''
      for await (const piece of spawnPython($, args, { cwd: cwd || undefined })) {
        streamed = true
        if (typeof piece.text === 'string') {
          buf += piece.text
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            onLine(buf.slice(0, nl))
            buf = buf.slice(nl + 1)
          }
        }
      }
      if (buf.trim()) onLine(buf)
    } catch (err) {
      if (streamed) throw err
      // No streaming on this build: one batch run, start and finish only.
      const r = await runPython($, args, { timeoutMs: 90_000 })
      for (const line of (r.stdout || r.stderr || '').split('\n')) onLine(line)
    }
    const failed = skipped > 0 && ok === 0
    const row = applyProgress({ id: rowId, stage: skipped ? `${skipped} skipped` : 'Done', step: total, total, state: failed ? 'failed' : 'done', percent: 100 })
    if (row) row.expireAt = Date.now() + (skipped ? 15000 : 8000)
    skillsMsg = summary || `${label}: ${ok} done${skipped ? `, ${skipped} skipped` : ''}`
    try { $.ui.toast(`${skillsMsg} · loads after /clear`, { timeoutMs: 8000 }) } catch { /* no UI */ }
  } catch (err) {
    skillsMsg = `could not run skills.py: ${err && err.message ? err.message : String(err)}`
    const row = applyProgress({ id: rowId, stage: 'error', state: 'failed', percent: 100 })
    if (row) row.expireAt = Date.now() + 15000
  }
  skillsBusy = false
  try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
  await refreshSkills($, cwd)
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x))
}

/** Apply one `progress` call to the rows. Returns the row, or null when removed. */
function applyProgress(e) {
  const id = String(e.id || 'job')
  if (e.remove) {
    progressRows.delete(id)
    return null
  }
  const row = progressRows.get(id) || { id, label: id, stage: '', step: 0, total: 0, state: 'running', target: 0, shown: 0, note: '' }
  if (typeof e.label === 'string' && e.label) row.label = e.label
  if (typeof e.stage === 'string') row.stage = e.stage
  if (Number.isFinite(e.total)) row.total = Math.max(0, Math.floor(e.total))
  if (Number.isFinite(e.step)) row.step = Math.max(0, Math.floor(e.step))
  if (typeof e.state === 'string' && STATE_COLOR[e.state]) row.state = e.state
  if (typeof e.note === 'string') row.note = e.note
  if (Number.isFinite(e.percent)) row.target = clamp01(e.percent / 100)
  else if (row.total > 0) row.target = clamp01((Math.max(1, row.step) - 1) / row.total)
  if (row.state === 'done') {
    row.target = 1
    if (row.total > 0) row.step = row.total
    if (!row.stage) row.stage = 'Done'
  }
  progressRows.set(id, row)
  return row
}

function pillText(row) {
  const lead = row.state === 'done' ? '✓ ' : row.state === 'failed' ? '✕ ' : row.state === 'waiting' ? '? ' : ''
  const count = row.total > 0 ? ` ${Math.max(1, Math.min(row.step || 1, row.total))}/${row.total}` : ''
  return `${lead}${row.stage || row.label}${count}`
}

/** Desktop and the web surfaces: a real bar. Dithered fill, stage ticks, a pill riding the head. */
function progressSvg(row, width) {
  const W = Math.max(160, Math.floor(width)), H = 22, R = 11
  const color = STATE_COLOR[row.state]
  const head = Math.round(W * row.shown)
  const label = pillText(row)
  const pillW = Math.min(W, Math.round(label.length * 6.9 + 22))
  const pillX = Math.max(0, Math.min(W - pillW, head - pillW + 6))
  const ticks = []
  for (let i = 1; i < row.total && row.total <= 40; i++) {
    const x = (W * i) / row.total
    ticks.push(`<rect x="${x.toFixed(1)}" y="4" width="1.2" height="${H - 8}" fill="${x <= head ? '#ffffff' : color}" opacity="${x <= head ? 0.9 : 0.35}"/>`)
  }
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><pattern id="d" width="4" height="4" patternUnits="userSpaceOnUse">` +
    `<rect x="0" y="0" width="1.6" height="1.6" fill="${color}" opacity="0.95"/>` +
    `<rect x="2" y="2" width="1.6" height="1.6" fill="${color}" opacity="0.55"/>` +
    `<rect x="2" y="0" width="1" height="1" fill="${color}" opacity="0.3"/></pattern>` +
    `<clipPath id="c"><rect x="0" y="0" width="${W}" height="${H}" rx="${R}"/></clipPath></defs>` +
    `<rect x="0" y="0" width="${W}" height="${H}" rx="${R}" fill="#2b2b30"/>` +
    `<g clip-path="url(#c)"><rect x="0" y="0" width="${head}" height="${H}" fill="url(#d)"/>` +
    `<rect x="0" y="0" width="${head}" height="${H}" fill="${color}" opacity="0.12"/>${ticks.join('')}</g>` +
    `<rect x="${pillX}" y="0" width="${pillW}" height="${H}" rx="${R}" fill="${color}"/>` +
    `<text x="${pillX + pillW / 2}" y="15" text-anchor="middle" font-family="-apple-system, Inter, Segoe UI, sans-serif" font-size="12" font-weight="600" fill="#ffffff">${esc(label)}</text>` +
    `</svg>`
  )
}

/** The terminal: a block-glyph track with a dithered fill, dim ticks, and an inverse pill at the head. */
function progressTrackText(row, cells, h, Text) {
  const color = STATE_COLOR[row.state]
  const head = Math.round(cells * row.shown)
  const label = ` ${pillText(row)} `
  const pillW = Math.min(cells, label.length)
  const pillX = Math.max(0, Math.min(cells - pillW, head - pillW + 1))
  const tickAt = new Set()
  for (let i = 1; i < row.total && row.total <= cells; i++) tickAt.add(Math.round((cells * i) / row.total))
  const parts = []
  let run = ''
  let runKind = ''
  const flush = () => {
    if (!run) return
    if (runKind === 'fill') parts.push(h(Text, { color }, run))
    else parts.push(h(Text, { dimColor: true }, run))
    run = ''
  }
  for (let x = 0; x < cells; x++) {
    if (x === pillX) {
      flush()
      parts.push(h(Text, { color, inverse: true, bold: true }, label.slice(0, pillW)))
      x += pillW - 1
      continue
    }
    let ch, kind
    if (tickAt.has(x)) { ch = '│'; kind = 'tick' }
    else if (x < head) { ch = (x * 7 + row.id.length) % 5 === 0 ? '░' : '▒'; kind = 'fill' }
    else { ch = '·'; kind = 'track' }
    if (kind !== runKind) { flush(); runKind = kind }
    run += ch
  }
  flush()
  return parts
}

function progressSettled() {
  for (const r of progressRows.values()) if (Math.abs(r.target - r.shown) > 0.004) return false
  return true
}

function daysAgo(ts) {
  if (!ts) return 'never'
  const d = Math.floor((Date.now() / 1000 - ts) / 86400)
  return d <= 0 ? 'today' : `${d}d ago`
}

export function register(on, options = {}) {
  const quietBash = options.quietBash !== false
  const trimOutput = options.trimOutput !== false
  const cacheBand = options.cacheBand !== false
  const compactHint = options.compactHint !== false
  const compactGuard = options.compactGuard !== false
  const suggestSkills = options.suggestSkills !== false
  const ttl = options.longCacheTtl ? TTL_LONG : TTL_SHORT

  on('session.start', async ($, e, next) => {
    await loadConfig($, e.cwd)
    bandHidden = false
    announcedPct = 0
    try {
      // Once per machine: say what changed, so the first session after install is not a mystery.
      if (!(await $.store.get('welcomed'))) {
        await $.store.set('welcomed', true)
        const msg = 'token-saver is on: cache band above the prompt · /tokens · /loadout · /compact is guarded when the cache is cold'
        $.ui.log(msg)
        try { $.ui.toast(msg, { timeoutMs: 12000 }) } catch { /* no UI */ }
      }
    } catch {
      /* no store on this build */
    }
    try {
      await $.command.register({
        name: 'tokens',
        description: 'Token-saver totals, cache clock and your context thresholds. No model turn.',
      })
      await $.command.register({
        name: 'loadout',
        description:
          'Your skill loadout. Every skill costs tokens each turn: /loadout opens a pane to park, link and bring back skills; /loadout <names…> parks, /loadout back|link|unlink <names…>, /loadout list, /loadout suggest. Takes effect next session.',
      })
    } catch {
      /* command API missing on older builds */
    }
    if (quietBash && pythonQuietOn) {
      try {
        $.ui.log(
          'token-saver: the Python quiet-bash hook is on, so the mod leaves Bash rewrites to it. ' +
            'Run one or the other: ./install.sh --disable quiet-bash',
        )
      } catch {
        /* no UI */
      }
    }
    try {
      await $.tool.register({
        name: 'progress',
        description:
          'Show a progress bar above the prompt for a job with several stages (a build, a migration, a multi-file refactor, a test matrix). ' +
          'Call it when the job starts and again whenever a stage begins, ends, waits or fails; the same id updates the same bar. ' +
          'Fields: id (stable per job), label (what the job is), stage (current stage name), step (1-based stage number), total (stage count), ' +
          'state: running | waiting | failed | done, percent (optional 0-100 override), note (optional short text), remove: true to drop the bar. ' +
          'Keep calls short; this draws UI and returns one line.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            label: { type: 'string' },
            stage: { type: 'string' },
            step: { type: 'integer', minimum: 0 },
            total: { type: 'integer', minimum: 0 },
            state: { type: 'string', enum: ['running', 'waiting', 'failed', 'done'] },
            percent: { type: 'number', minimum: 0, maximum: 100 },
            note: { type: 'string' },
            remove: { type: 'boolean' },
          },
          required: ['id'],
        },
      })
    } catch {
      /* tool API missing on older builds */
    }
    progressRows.clear()
    progressTicker = $.clock.every(70, () => {
      if (progressRows.size === 0) return
      const now = Date.now()
      let changed = false
      for (const [id, r] of progressRows) {
        if (r.expireAt && now >= r.expireAt) {
          progressRows.delete(id)
          changed = true
        }
      }
      if (changed) {
        try { $.ui.status(progressRows.size ? 'Progress' : undefined) } catch { /* no UI */ }
      }
      if (!changed && progressSettled()) return
      for (const r of progressRows.values()) r.shown += (r.target - r.shown) * 0.16
      try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
    })
    if (cacheBand) {
      // Keeps "warm Nm" honest while the person thinks. Runs until the module reloads.
      $.clock.every(BAND_TICK, () => {
        if (lastStepAt) $.ui.invalidate('ui.render')
      })
    }
    if (suggestSkills) {
      // Parked skills that fit this repo: one UI line, nothing into the prompt.
      try {
        const r = await runPython($, [`${$.plugin.root}/scripts/skills.py`, 'suggest', '--brief', '--project', e.cwd], {
          timeoutMs: 8000,
        })
        const line = (r.stdout || '').trim()
        if (r.exitCode === 0 && line) {
          $.ui.log(`token-saver: ${line}`)
          // The log line is enough on repeat visits; the toast shows once a day per repo.
          const key = `suggest-toast:${e.cwd}`
          const today = new Date().toISOString().slice(0, 10)
          const seen = await $.store.get(key)
          if (seen !== today) {
            await $.store.set(key, today)
            try { $.ui.toast(line.split('. Enable here')[0] + '. See /loadout suggest', { timeoutMs: 8000 }) } catch { /* no UI */ }
          }
        }
      } catch {
        /* no python, no UI, or slow disk: stay quiet */
      }
    }
    return next(e)
  })

  on('command.run', { command: 'tokens' }, async ($, e) => {
    const arg = (e.args || '').trim().toLowerCase()
    if (arg === 'hide' || arg === 'show') {
      bandHidden = arg === 'hide'
      try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
      return { text: bandHidden ? 'band hidden for this session · /tokens show brings it back' : 'band shown' }
    }
    const ctx = await contextOf($)
    const clock = cacheClock(await $.clock.now(), ttl)
    const u = lastUsage || {}
    const cache = !clock.known
      ? 'cache: no response yet'
      : clock.warm
        ? `cache warm, ~${mins(clock.leftMs)}m left (ttl ${options.longCacheTtl ? '1h' : '5m'})`
        : `cache cold, idle ${mins(clock.idleMs)}m`
    const window = ctx.window ? ` of ${fmt(ctx.window)} (${ctx.percent}%)` : ''
    return {
      text: [
        `context       ${fmt(ctx.tokens)} tok${window}  ·  ${cache}`,
        `last request  in ${fmt(u.input_tokens)}  out ${fmt(u.output_tokens)}  cache-read ${fmt(u.cache_read_input_tokens)} (${hitPct(u)}%)`,
        `this session  rewrites ${rewrites}  trimmed ~${fmt(savedChars)} chars  compactions vetoed ${vetoes}`,
        hintFor(ctx.percent, clock) || 'under your lowest threshold',
        'limits: ~/.claude/token-saver/thresholds.json  ·  /tokens hide|show  ·  override a veto: /compact force',
      ].join('\n'),
    }
  })

  /**
   * /loadout → scripts/skills.py inside the plugin. No shell: argv only.
   * The interactive picker needs a TTY, so it stays a terminal command.
   */
  on('command.run', { command: 'loadout' }, async ($, e) => {
    const words = (e.args || '').trim().split(/\s+/).filter(Boolean)
    if (words.length === 0 || words[0] === 'pane') {
      // The pane: rows with Park / Link / Unpark / Unlink buttons. Text fallback where panes do not draw.
      let cwd = ''
      try { cwd = await $.session.cwd() } catch { /* fine */ }
      void refreshSkills($, cwd)
      try {
        await $.ui.open({ id: SKILLS_PANE, title: 'Loadout', focus: true, closeOnEscape: true, holdToasts: true })
        return { text: 'Loadout pane opened. Esc closes it. /loadout list prints the same as text.' }
      } catch {
        words.splice(0, words.length, 'status')
      }
    }
    if (words[0] === 'list') words[0] = 'status'
    if (words[0] === 'back') words[0] = 'unpark'
    const verbs = ['status', 'suggest', 'park', 'unpark', 'link', 'unlink']
    if (!verbs.includes(words[0]) && words[0] !== 'help') words.unshift('park')   // /loadout gsap-*  →  park gsap-*
    const verb = words[0]
    if (!verbs.includes(verb)) {
      return { text: `usage: /loadout (pane) · /loadout <names…> · /loadout back|link|unlink <names…> · /loadout list · /loadout suggest [topic…]  ·  terminal picker: python3 ${$.plugin.root}/scripts/skills.py pick` }
    }
    if (verb === 'suggest' && words.length > 1) {
      // /loadout suggest gsap scroll animation  →  suggest --for "gsap scroll animation"
      words.splice(1, words.length - 1, '--for', words.slice(1).join(' '))
    }
    if (!['status', 'suggest'].includes(verb) && words.length < 2) {
      return { text: `/loadout ${verb} needs at least one name. Globs (gsap-*), groups (@gsap) and 'unused' work.` }
    }
    if (['park', 'unpark', 'link', 'unlink'].includes(verb)) {
      // Typed actions take the same path as the pane's buttons: a progress row per skill, then a refresh.
      let cwd = ''
      try { cwd = await $.session.cwd() } catch { /* fine */ }
      if (!skillsData) await refreshSkills($, cwd)
      await actSkills($, verb, words.slice(1), cwd)
      return { text: `${skillsMsg} · loads in the next session (/clear)` }
    }
    const argv = [`${$.plugin.root}/scripts/skills.py`, verb, ...words.slice(1)]
    try {
      const r = await runPython($, argv, { timeoutMs: 90_000 })
      const out = [r.stdout.trim(), r.exitCode ? r.stderr.trim() : ''].filter(Boolean).join('\n')
      return { text: out || `skills.py exited ${r.exitCode} with no output` }
    } catch (err) {
      return { text: `token-saver: could not run skills.py. It needs python3 (or python) on PATH. ${err && err.message ? err.message : String(err)}` }
    }
  })

  on('tool.call', { tool: PROGRESS_TOOL }, async ($, e) => {
    const row = applyProgress(e)
    try {
      $.ui.status(progressRows.size ? 'Progress' : undefined)
      $.ui.invalidate('ui.render')
    } catch {
      /* no UI */
    }
    const text = row
      ? `progress: ${row.label} — ${pillText(row)} (${Math.round(row.target * 100)}%, ${row.state})`
      : `progress: removed ${e.id}`
    return { result: { content: [{ type: 'text', text }], isError: false } }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    let event = e
    if (quietBash && !pythonQuietOn) {
      const hit = quiet(e.command)
      if (hit) {
        rewrites += 1
        event = { ...e, command: hit.next }
      }
    }
    const r = await next(event)
    if (!trimOutput || !r || r.deny || r.isError) return r
    const rec = r.result
    if (!rec || typeof rec.stdout !== 'string' || rec.stdout.length <= LIMIT) return r
    // Never trim a failure: stderr means the person needs the whole thing.
    if (typeof rec.stderr === 'string' && rec.stderr.trim()) return r
    savedChars += rec.stdout.length - HEAD - TAIL
    // A hook's own result: core re-maps it for the model. ref/text left off on purpose.
    return { result: { ...rec, stdout: trim(rec.stdout) } }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result && result.usage) {
      lastUsage = result.usage
      lastStepAt = await $.clock.now()
      try {
        $.ui.invalidate('ui.render')
      } catch {
        /* no UI */
      }
      if (compactHint) {
        // Nobody watches the band. Say it once, at the moment a threshold is crossed.
        try {
          const ctx = await contextOf($)
          const hit = levelFor(ctx.percent)
          if (hit && Number(hit.pct) > announcedPct) {
            announcedPct = Number(hit.pct)
            const clock = cacheClock(lastStepAt, ttl)
            $.ui.toast(`context ${ctx.percent}% — ${hintFor(ctx.percent, clock)}`, { timeoutMs: 12000 })
          }
        } catch {
          /* no UI or no usage yet */
        }
      }
    }
    return result
  })

  /**
   * Compaction guard.
   *  - every trigger: the keep-list is appended to the summarizer's instructions
   *  - manual /compact on a cold cache: vetoed, with the cost spelled out
   *  - "/compact force" (or "/compact !") compacts anyway
   *  - auto, plugin and precompute triggers are never vetoed: refusing an
   *    auto-compaction would let the window overflow
   *  - subagent transcripts are left alone
   */
  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e)
    const typed = (e.instructions || '').trim()
    const forced = /^(force|!)(\s|$)/i.test(typed)
    const own = forced ? typed.replace(/^(force|!)\s*/i, '') : typed
    const instructions = [own, KEEP].filter(Boolean).join('\n')

    if (compactGuard && e.trigger === 'manual' && !forced) {
      const clock = cacheClock(await $.clock.now(), ttl)
      if (clock.known && !clock.warm) {
        vetoes += 1
        const ctx = await contextOf($)
        return {
          skip:
            `token-saver: prompt cache is cold (idle ${mins(clock.idleMs)}m). ` +
            `/compact would re-send ~${fmt(ctx.tokens)} tokens before summarizing. ` +
            'Prefer /handoff then /clear. To compact anyway: /compact force',
        }
      }
    }
    return next({ ...e, instructions })
  })

  on('ui.render', { component: 'Pane', requestId: SKILLS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = (e.props && e.props.bodyColumns) || (e.viewport && e.viewport.columns) || 80
    const narrow = width < 64
    let cwd = ''
    try { cwd = await $.session.cwd() } catch { /* fine */ }
    const col = (children) => h(Box, { flexDirection: 'column' }, ...children)
    const row = (children) => h(Box, { flexDirection: 'row' }, ...children)
    const dim = (t) => h(Text, { dimColor: true }, t)
    const text = (t) => h(Text, null, t)
    const bold = (t) => h(Text, { bold: true }, t)
    const pad = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t.padEnd(n))

    if (!skillsData) {
      return col([
        dim(skillsBusy ? 'reading skills…' : 'no data yet'),
        h(Button, { key: 'refresh', label: 'Refresh', hotkey: 'r', onPress: () => refreshSkills($, cwd) }),
      ])
    }
    if (skillsData.error) {
      return col([text(`token-saver: ${skillsData.error}`), dim('skills.py needs python3 or python on PATH'),
        h(Button, { key: 'refresh', label: 'Refresh', hotkey: 'r', onPress: () => refreshSkills($, cwd) })])
    }
    const d = skillsData
    const unused = new Set(d.unused || [])
    const linked = new Set(d.project_links || [])
    const usage = d.usage || {}
    const active = [...(d.active || [])].sort((a, b) => (unused.has(b.name) - unused.has(a.name)) || (b.per_turn - a.per_turn) || a.name.localeCompare(b.name))
    const parked = [...(d.parked || [])].sort((a, b) => ((usage[b.name] ? 1 : 0) - (usage[a.name] ? 1 : 0)) || a.name.localeCompare(b.name))
    const nameW = Math.min(30, Math.max(12, ...active.concat(parked).map((x) => x.name.length)))

    const header = [
      row([
        bold('Loadout  '),
        dim(`active ${active.length} ≈${d.per_turn_tokens} tok every turn · parked ${parked.length} ≈${d.parked_tokens} kept out  `),
      ]),
      row([
        h(Button, { key: 'refresh', label: skillsBusy ? 'working…' : 'Refresh', hotkey: 'r', onPress: () => refreshSkills($, cwd) }),
        text(' '),
        ...(unused.size
          ? [h(Button, { key: 'park-unused', label: `Park ${unused.size} unused`, hotkey: 'u', variant: 'primary', onPress: () => actSkills($, 'park', ['unused'], cwd) })]
          : [dim('nothing unused 30+ days')]),
      ]),
      text(' '),
    ]

    const activeRows = active.length
      ? active.map((sk) => row([
          dim(unused.has(sk.name) ? '· ' : '  '),
          text(pad(sk.name, nameW)),
          dim(`  ${String(sk.per_turn).padStart(4)} tok  `),
          ...(narrow ? [] : [dim(pad(usage[sk.name] ? `${daysAgo(usage[sk.name].last)} ×${usage[sk.name].count}` : 'never', 14))]),
          h(Button, { key: `park:${sk.name}`, label: 'Park', onPress: () => actSkills($, 'park', [sk.name], cwd) }),
        ]))
      : [dim('  no active skills')]

    const parkedRows = parked.length
      ? parked.map((sk) => row([
          dim(usage[sk.name] ? '! ' : '  '),
          text(pad(sk.name, nameW)),
          dim(`  ${String(sk.per_turn).padStart(4)} tok  `),
          ...(narrow ? [] : [dim(pad(usage[sk.name] ? `used ${daysAgo(usage[sk.name].last)}` : '', 14))]),
          ...(linked.has(sk.name)
            ? [dim('linked here  '), h(Button, { key: `unlink:${sk.name}`, label: 'Unlink', onPress: () => actSkills($, 'unlink', [sk.name], cwd) })]
            : [h(Button, { key: `link:${sk.name}`, label: 'Link here', onPress: () => actSkills($, 'link', [sk.name], cwd) }), text(' '),
               h(Button, { key: `unpark:${sk.name}`, label: 'Unpark', onPress: () => actSkills($, 'unpark', [sk.name], cwd) })]),
        ]))
      : [dim('  nothing parked')]

    return col([
      ...header,
      bold('Active'), dim('  · = no Skill call in local transcripts for 30+ days'),
      ...activeRows,
      text(' '),
      bold('Parked'), dim('  ! = used while parked → Link here (this repo) or Unpark (everywhere)'),
      ...parkedRows,
      text(' '),
      dim(skillsMsg ? `${skillsMsg}  ·  loads in the next session (/clear)` : 'Park moves a skill out of every session; Link brings it back for this repo only. Loads in the next session (/clear).'),
      ...(d.scan_note ? [dim(d.scan_note)] : []),
    ])
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props && e.props.hasSurvey) return next(e)
    const showTokens = cacheBand && lastUsage && !bandHidden
    if (progressRows.size === 0 && !showTokens) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = $.ui.resolve(e).Svg
    const width = (e.props && e.props.bodyColumns) || (e.viewport && e.viewport.columns) || 80
    const children = []
    for (const row of progressRows.values()) {
      const color = STATE_COLOR[row.state]
      const pct = `${Math.round(row.shown * 100)}%`.padStart(4)
      const labelW = Math.min(28, Math.max(10, row.label.length))
      const close = h(Button, { key: `progress-close:${row.id}`, label: '×', plain: true, onPress: () => {
        progressRows.delete(row.id)
        try { $.ui.status(progressRows.size ? 'Progress' : undefined); $.ui.invalidate('ui.render') } catch { /* no UI */ }
      } })
      const lead = [h(Text, { color }, STATE_GLYPH[row.state] + ' '), h(Text, null, row.label.slice(0, labelW).padEnd(labelW) + '  ')]
      if (Svg && e.surface !== 'terminal') {
        const barPx = Math.max(180, Math.min(420, (width - labelW - 14) * 7))
        children.push(h(Box, { flexDirection: 'row', alignItems: 'center', gap: 1 }, ...lead,
          h(Svg, { source: progressSvg(row, barPx), alt: `${row.label}: ${pillText(row)}, ${pct.trim()}`, height: 22 }),
          h(Text, { dimColor: true }, ` ${pct} `), close))
      } else {
        const cells = Math.max(16, Math.min(48, width - labelW - 16))
        children.push(h(Box, { flexDirection: 'row' }, ...lead, ...progressTrackText(row, cells, h, Text), h(Text, { dimColor: true }, ` ${pct} `), close))
      }
      if (row.note) children.push(h(Text, { dimColor: true }, '    ' + row.note))
    }
    if (showTokens) {
      try {
        const ctx = await contextOf($)
        const clock = cacheClock(await $.clock.now(), ttl)
        const cache = clock.warm ? `warm ${mins(clock.leftMs)}m` : 'cold'
        const parts = [
          `token-saver  ctx ${fmt(ctx.tokens)}${ctx.window ? ` (${ctx.percent}%)` : ''}  cache ${hitPct(lastUsage)}% ${cache}  trimmed ${fmt(savedChars)}  /tokens`,
        ]
        if (compactHint) {
          const hint = hintFor(ctx.percent, clock)
          if (hint) parts.push(hint)
        }
        children.push(h(
          Box,
          null,
          h(Text, { dimColor: true }, parts.join('  ·  ') + '  '),
          h(Button, {
            key: 'hide',
            label: 'Hide',
            onPress: () => {
              bandHidden = true
              try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
            },
          }),
        ))
      } catch {
        /* usage unavailable: progress rows still draw */
      }
    }
    if (children.length === 0) return next(e)
    return h(Box, { flexDirection: 'column' }, ...children)
  })
}
