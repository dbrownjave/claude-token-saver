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
const KEEP_WARM_TICK = 15 * 1000
const KEEP_WARM_LEAD = 75 * 1000          // the TTL runs from a request's start and a fork takes seconds: ping well before it lapses
const KEEP_WARM_PROMPT = 'Keep-alive ping from the token-saver plugin. Reply with a single period and nothing else.'

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
const totals = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, keptOut: 0, vetoTokens: 0 }   // this session, from turn.step usage
let limitBase = null            // { pct, tokens } when the five-hour window was first seen: tokens per % of window
let monthSaved = { key: '', tok: 0, usd: 0, sessionTok: 0, sessionUsd: 0 }   // carried in $.store across sessions
let announcedPct = 0            // highest threshold already toasted this session
/**
 * Keep-warm: while you are idle, re-read the session's own cached prefix ($.model.fork) shortly before the 5-minute TTL
 * lapses, so your next message hits the cache instead of re-writing it. A read costs 0.1× fresh input and refreshes the
 * TTL; a lapse costs a 1.25× re-write, so a ping pays while pings × 0.1 < chance-you-return × 1.15. The cap (default 5,
 * about 20 minutes) assumes about even odds. Costs and savings are booked in fresh-input-token equivalents.
 */
const keepWarm = { on: false, streak: 0, pings: 0, misses: 0, costTok: 0, savedTok: 0, busy: false, refreshedAt: 0, stopped: '' }
let inTurn = false
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
  const idleMs = Math.max(0, now - Math.max(lastStepAt, keepWarm.refreshedAt))   // a keep-warm ping refreshes the TTL too
  return { known: true, warm: idleMs < ttl, idleMs, leftMs: Math.max(0, ttl - idleMs) }
}

/** Whether a keep-warm ping is due now, else why not. Pure: every input is passed in. */
function keepWarmDue(w, now, lastStep, ttl, maxPings, turnRunning) {
  if (!w.on) return 'off'
  if (turnRunning) return 'turn running'
  if (w.busy) return 'busy'
  if (!lastStep) return 'no response yet'
  const idle = now - Math.max(lastStep, w.refreshedAt)
  if (idle >= ttl) return 'lapsed'
  if (ttl - idle > KEEP_WARM_LEAD) return 'not yet'
  if (w.streak >= maxPings) return 'cap'
  return 'ping'
}

/** One input-token-equivalent figure for what a call cost: write 1.25×, read 0.1×, output 5×. */
function billedTok(u) {
  if (!u) return 0
  return Math.round((u.input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0) + 5 * (u.output_tokens || 0))
}

async function tickKeepWarm($, ttl, maxPings) {
  const now = await $.clock.now()
  if (keepWarmDue(keepWarm, now, lastStepAt, ttl, maxPings, inTurn) !== 'ping') return
  keepWarm.busy = true
  try {
    // API billing only: a subscription already caches the main thread for an hour, and a ping would spend plan quota
    let u = null
    try { u = await $.session.usage() } catch { /* no usage API */ }
    if (!(u && u.cost && Number.isFinite(u.cost.usd))) { keepWarm.stopped = 'not API billing'; keepWarm.on = false; return }
    const r = await $.model.fork({ prompt: KEEP_WARM_PROMPT })
    if (r.usage) keepWarm.costTok += billedTok(r.usage)
    if (!r.isAnswered && r.reason === 'nothing-to-fork') return
    keepWarm.pings += 1
    keepWarm.streak += 1
    const read = (r.usage && r.usage.cache_read_input_tokens) || 0
    if (r.isAnswered && read >= 0.8 * sentOf(r.usage)) keepWarm.refreshedAt = now
    else { keepWarm.misses += 1; keepWarm.streak = Infinity }   // already lapsed (model switch, eviction) or failed: stop paying this stretch
    try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
  } finally {
    keepWarm.busy = false
  }
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
  const liveNow = row.state === 'running' || row.state === 'waiting'
  if (!liveNow && row.settledAt === undefined) row.settledAt = progressTick * TICK_S
  if (liveNow) row.settledAt = undefined
  progressRows.set(id, row)
  return row
}

function pillText(row) {
  if (row.plain) return row.stage || ''                       // a gauge: just the figure, no state prefix
  const lead = row.state === 'done' ? '✓ ' : row.state === 'failed' ? '✕ ' : row.state === 'waiting' ? '? ' : ''
  const count = row.total > 0 ? ` ${Math.max(1, Math.min(row.step || 1, row.total))}/${row.total}` : ''
  return `${lead}${row.stage || row.label}${count}`
}

/** Shared by every surface: the dot-matrix palette. Deterministic, so a frame never flickers between redraws. */
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function rgbHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}
/** `color` scaled toward black by `f` (0..1), mixed a touch toward the track so the dim end still reads as the state. */
function shade(hex, f) {
  const [r, g, b] = hexRgb(hex)
  const t = Math.max(0, Math.min(1, f))
  return rgbHex(0x2b + (r - 0x2b) * t, 0x2b + (g - 0x2b) * t, 0x30 + (b - 0x30) * t)
}
/** A small integer hash of a grid position; ~15% of filled squares sit one step dimmer. */
function dotHash(col, row, salt) {
  let x = (col * 374761393 + row * 668265263 + salt * 2246822519) | 0
  x = Math.imul(x ^ (x >>> 13), 1274126177)
  return (x ^ (x >>> 16)) >>> 0
}
const DOT_UNFILLED = '#3a3a40'
const DOT_TRACK = '#242428'
const THUMB_TEXT = '#1d1d21'
let progressTick = 0            // advanced by the band ticker, 70 ms apiece; every frame is a pure function of it
const TICK_S = 0.07

/**
 * The Effort slider's own recipe (its fragment shader, ported): a grid of small rounded cells; bursts
 * race out from the head as Manhattan-distance wavefronts with per-cell jitter; energy quantizes to a
 * five-step ramp from white to the state's hot ink; top-step cells breathe; a charged bed deepens
 * toward the head and stays once reached; the left quarter fades. Tuned brighter than the slider
 * (ink floor .25, ceiling 1, gain 1.4, lifted bed) at the person's request.
 */
const SH = {
  SPEED_LO: 20, SPEED_HI: 36, RANGE_LO: 10, RANGE_HI: 55, DENSITY_LO: 0.30, DENSITY_HI: 0.85, JITTER: 0.10,
  HEAD_GAIN: 1.25, HEAD_DECAY: 5, BODY_GAIN: 0.65, BODY_LO: 3.3, BODY_HI: 0.77, AMP_LO: 0.55, MAX_AGE: 5,
  RAMP_POW: 1.4, BREATH_DIP: 0.28, BREATH_BASE: 2.4, BREATH_VARY: 1.4,
  inkFloor: 0.25, inkCeil: 1, gain: 1.4, chargeMax: 1, mask: 0.25, fadeUp: 0.7, burstRamp: 2, sparkleFor: 60,
}
const INKS = {
  running: { hot: [0.70, 0.65, 1.00], c0: [0.78, 0.66, 1.00], c1: [0.55, 0.42, 0.95] },
  waiting: { hot: [1.00, 0.82, 0.48], c0: [1.00, 0.80, 0.40], c1: [0.80, 0.55, 0.18] },
  failed:  { hot: [1.00, 0.60, 0.63], c0: [1.00, 0.50, 0.54], c1: [0.85, 0.25, 0.30] },
  done:    { hot: [0.62, 0.94, 0.76], c0: [0.45, 0.90, 0.68], c1: [0.20, 0.65, 0.45] },
  cold:    { hot: [0.70, 0.70, 0.74], c0: [0.52, 0.52, 0.57], c1: [0.33, 0.33, 0.38] },
  orange:  { hot: [1.00, 0.74, 0.50], c0: [1.00, 0.62, 0.36], c1: [0.80, 0.40, 0.20] },
  blue:    { hot: [0.62, 0.76, 1.00], c0: [0.45, 0.62, 0.98], c1: [0.22, 0.40, 0.80] },
  green:   { hot: [0.66, 0.90, 0.66], c0: [0.48, 0.78, 0.48], c1: [0.25, 0.50, 0.28] },
  yellow:  { hot: [0.98, 0.86, 0.45], c0: [0.86, 0.72, 0.28], c1: [0.60, 0.48, 0.14] },
}
const SEG_INK = { messages: 'blue', tools: 'orange', files: 'green', system: 'yellow', buffer: 'cold' }
const TRACK_RGB = [0.165, 0.165, 0.18]      // #2a2a2e
const BAR_H = 14, BAR_ROWS = 3, BAR_RADIUS = 4

function hash21(x, y) {
  const v = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return v - Math.floor(v)
}
const mixN = (a, b, t) => a + (b - a) * t
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const toHex = (c) => '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')).join('')

function rowSeed(row) {
  return (hash21(row.id.length, row.id.charCodeAt(0) || 7) * 512) | 0
}

/**
 * The burst schedule, deterministic: burst i fires at a hashed interval after burst i-1, at the head,
 * with a strength that ramps up over the first two seconds. A finished row switches to faint sparks at
 * random points along the fill for `sparkleFor` seconds, then holds still. Returns the live bursts.
 */
function burstsAt(row, t, seed) {
  const live = row.live === true || row.state === 'running' || row.state === 'waiting'
  const out = []
  if (live) {
    let T = 0
    for (let i = 0; i < 400 && T <= t; i++) {
      const gap = 0.3 + 0.45 * hash21(seed + i * 1.7, 3.3)
      if (T >= t - SH.MAX_AGE) {
        const k = Math.min(T / SH.burstRamp, 1)
        const e = 0.6 + 0.4 * row.shown
        const gain = Math.min((0.15 + 0.7 * e) * (0.45 + 0.55 * k), 1) * (0.85 + 0.3 * hash21(seed + i * 2.9, 5.1))
        out.push({ t: T, x: row.shown + (hash21(seed + i * 4.1, 7.7) - 0.5) * 0.08, y: 0.35 + 0.3 * hash21(seed + i * 6.3, 9.9), k: gain })
      }
      T += gap
    }
  } else {
    const t0 = row.settledAt || 0
    out.push({ t: t0, x: row.shown, y: 0.5, k: 0.9 })                 // the one front that charges the bed
    if (row.state === 'done' && t - t0 < SH.sparkleFor) {
      let T = t0 + 1.2
      for (let i = 0; i < 200 && T <= t; i++) {
        if (T >= t - SH.MAX_AGE) out.push({ t: T, x: row.shown * (0.08 + 0.92 * hash21(seed + i * 3.7, 2.2)), y: 0.2 + 0.6 * hash21(seed + i * 5.3, 4.4), k: 0.3 + 0.15 * hash21(seed + i * 1.3, 6.6) })
        T += 0.5 + 0.7 * hash21(seed + i * 2.1, 8.8)
      }
    }
  }
  return out.slice(-8)
}

/** Colour of one cell as [r,g,b] 0..1 composited over the track, or null where nothing paints. */
function shadeCell(row, cx, cy, cols, rows, t, bursts, seed, pitchPx, W) {
  const live = row.live === true || row.state === 'running' || row.state === 'waiting'
  const pos = Math.max(row.shown, 0.02)
  const px = (cx + 0.5) * pitchPx
  if (px > pos * W + pitchPx) return null
  const L = live ? Math.min(t / SH.fadeUp, 1) : 1
  const jitter = (hash21(cx + 41.7 + seed, cy + 41.7 + seed) - 0.5) * 2 * SH.JITTER
  const vary = 0.35 + 0.65 * hash21(cx + 13.7 + seed, cy + 13.7 + seed)
  let energy = 0, charged = 0
  for (const b of bursts) {
    const age = t - b.t
    if (age < 0 || age > SH.MAX_AGE) continue
    const ox = Math.floor((b.x * W) / pitchPx), oy = Math.floor(b.y * rows)
    const manh = Math.abs(cx - ox) + Math.abs(cy - oy)
    const range = mixN(SH.RANGE_LO, SH.RANGE_HI, b.k)
    const falloff = Math.exp(-manh / (range * 0.85)), reach = Math.exp(-Math.max(manh - range, 0) * 0.12)
    const tt = age - manh / mixN(SH.SPEED_LO, SH.SPEED_HI, b.k) - jitter
    charged = Math.max(charged, smooth(0, 0.15, tt) * reach)
    if (tt < 0) continue
    if (hash21(cx + 7.3 + seed + b.t, cy + 7.3 + seed + b.t) > mixN(SH.DENSITY_LO, SH.DENSITY_HI, b.k)) continue
    const head = SH.HEAD_GAIN * Math.exp(-tt * SH.HEAD_DECAY), body = SH.BODY_GAIN * Math.exp(-tt * mixN(SH.BODY_LO, SH.BODY_HI, b.k))
    energy += (head + body) * mixN(SH.AMP_LO, 1, b.k) * falloff * reach * vary
  }
  if (!live && t - (row.settledAt || 0) > 1.6) charged = 1          // a finished row keeps its bed
  const lumA = hash21(cx + 8.8 + seed, cy + 8.8 + seed), lumB = hash21(cx + 88.8 + seed, cy + 88.8 + seed)
  const lum = Math.pow(mixN(lumA, lumB, 0.5 + 0.5 * Math.sin(t * 0.35 + lumA * 6.2832)), 1.9)
  const stream = 0.9 + 0.16 * Math.sin(t * 1.3 + cx * 0.45 + lumB * 2)
  const e = Math.min(Math.max(energy, 0), 1) * L * mixN(0.16, 1, lum) * stream * SH.gain
  let ink = INKS[row.state] || INKS.running
  if (row.segments) { const f = px / W; const sg = row.segments.find((x) => f <= x.end) || row.segments[row.segments.length - 1]; if (sg) ink = INKS[sg.ink] || ink }
  const g = Math.max(0, Math.min(1, px / Math.max(pos * W, 1)))
  const chargeA = SH.chargeMax * Math.pow(g, 1.1) * charged * L
  const lv = (e > 0.04) + (e > 0.2) + (e > 0.4) + (e > 0.6) + (e > 0.8)
  let alpha = lv <= 0 ? 0 : mixN(SH.inkFloor, SH.inkCeil, (lv - 1) / 4)
  if (lv >= 5) {
    const period = SH.BREATH_BASE + SH.BREATH_VARY * hash21(cx + 3.1 + seed, cy + 3.1 + seed)
    alpha *= 1 - SH.BREATH_DIP * 0.5 * (1 + Math.sin((t * 6.2832) / period + hash21(cx + 5.5 + seed, cy + 5.5 + seed) * 6.2832))
  }
  const a = alpha + chargeA * (1 - alpha)
  if (a <= 0) return null
  const q = Math.pow(lv / 5, SH.RAMP_POW)
  const m = SH.mask ? Math.min(1, px / (SH.mask * W)) : 1
  return [0, 1, 2].map((i) => {
    const inkc = mixN(1, ink.hot[i], q)
    const bed = mixN(ink.c0[i], ink.c1[i], g)
    const col = inkc * alpha + bed * chargeA * (1 - alpha)
    return Math.min(1, TRACK_RGB[i] * (1 - a * m) + col * m)
  })
}

/** Desktop and the web surfaces: the slider's cells at 14 px, squared corners, a gradient text pill trailing the head. */
function progressSvg(row, width, marks = []) {
  const W = Math.max(160, Math.floor(width)), H = BAR_H, rows = BAR_ROWS
  const pitch = H / rows, cellHalf = (3 / 4) * pitch / 2, cols = Math.ceil(W / pitch)
  const t = progressTick * TICK_S
  const seed = rowSeed(row)
  const bursts = burstsAt(row, t, seed)
  const squares = []
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const c = shadeCell(row, cx, cy, cols, rows, t, bursts, seed, pitch, W)
      if (!c) continue
      const x = (cx + 0.5) * pitch - cellHalf, y = (cy + 0.5) * pitch - cellHalf
      squares.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(cellHalf * 2).toFixed(1)}" height="${(cellHalf * 2).toFixed(1)}" rx="0.9" fill="${toHex(c)}"/>`)
    }
  }
  const label = pillText(row)
  const ink = INKS[row.state] || INKS.running
  const pw = Math.min(W - 4, Math.round(label.length * 6.1 + 14))
  const headX = Math.max(row.shown, 0.02) * W
  const px = headX + pw + 2 <= W ? headX : Math.max(2, W - pw - 2)         // trail the head; flip behind it at the right end
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const gid = `g${row.id.replace(/[^a-z0-9]/gi, '')}`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<defs><clipPath id="c${gid}"><rect width="${W}" height="${H}" rx="${BAR_RADIUS}"/></clipPath>` +
    `<linearGradient id="${gid}" x1="0" x2="1"><stop offset="0" stop-color="${toHex(ink.c0)}"/><stop offset="1" stop-color="${toHex(ink.c1)}"/></linearGradient></defs>` +
    `<rect width="${W}" height="${H}" rx="${BAR_RADIUS}" fill="#2a2a2e"/>` +
    `<g clip-path="url(#c${gid})">${squares.join('')}${marks.map((m) => `<rect x="${(m.frac * W - 0.5).toFixed(1)}" y="2" width="1" height="${H - 4}" fill="${m.color || '#d4d3cf'}" opacity="0.9"/>`).join('')}</g>` +
    `<rect x="${px.toFixed(1)}" y="1" width="${pw}" height="${H - 2}" rx="${BAR_RADIUS}" fill="url(#${gid})"/>` +
    `<text x="${(px + pw / 2).toFixed(1)}" y="${H / 2 + 3.5}" text-anchor="middle" font-family="-apple-system, Inter, Segoe UI, sans-serif" font-size="10" font-weight="600" fill="#ffffff">${esc(label)}</text>` +
    `</svg>`
  )
}

/** Standard base64 of a byte array; the sandbox has no Buffer and toBase64 is not everywhere yet. */
function base64(bytes) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2]
    const n = (a << 16) | ((b || 0) << 8) | (c || 0)
    out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (b === undefined ? '=' : A[(n >> 6) & 63]) + (c === undefined ? '=' : A[n & 63])
  }
  return out
}
/** One-row Raster cells: a half-block square on every even global column, a blank gap between. `colorAt(col)` gives
 *  0xRRGGBB or null for the bare track. `offset` is the global index of this segment's first column. */
function rasterCells(columns, colorAt, offset = 0) {
  const DEFAULT = 0x01000000
  const words = new Uint32Array(columns * 3)
  let i = 0
  for (let c = 0; c < columns; c++) {
    const g = c + offset
    const col = colorAt(g)
    if (col === -2) { words[i++] = 0x2502; words[i++] = 0x9a9aa0; words[i++] = DEFAULT }                     // │ a mark
    else if (g % 2 === 1) { words[i++] = 0x20; words[i++] = DEFAULT; words[i++] = DEFAULT }                  // gap column
    else { words[i++] = 0x2580; words[i++] = col === null ? 0x33333a : col; words[i++] = DEFAULT }            // ▀ square, dim on the bare track
  }
  return base64(new Uint8Array(words.buffer))
}

/** The terminal: the same cells, one row, split around a coloured text pill that trails the head. */
function progressTrackText(row, cells, h, Text, Raster, marks = []) {
  const t = progressTick * TICK_S
  const seed = rowSeed(row)
  const bursts = burstsAt(row, t, seed)
  const ink = INKS[row.state] || INKS.running
  const label = ` ${pillText(row)} `
  const pillW = Math.min(cells, label.length)
  const head = Math.round(cells * Math.max(row.shown, 0.02))
  const pillX = head + pillW <= cells ? head : Math.max(0, cells - pillW)
  const thumb = h(Text, { color: '#ffffff', backgroundColor: toHex(ink.c1), bold: true }, label.slice(0, pillW))
  const markCols = new Set(marks.map((m) => Math.max(0, Math.min(cells - 1, Math.round(m.frac * cells)))))
  const colorAt = (x) => {
    if (markCols.has(x)) return -2
    const c = shadeCell(row, x, 0, cells, 1, t, bursts, seed, 1, cells)
    if (!c) return null
    return parseInt(toHex(c).slice(1), 16)
  }
  if (typeof Raster === 'function') {
    const parts = []
    if (pillX > 0) parts.push(h(Raster, { key: `progress-dots:${row.id}:l`, columns: pillX, rows: 1, cells: rasterCells(pillX, colorAt, 0) }))
    parts.push(thumb)
    const rest = cells - pillX - pillW
    if (rest > 0) parts.push(h(Raster, { key: `progress-dots:${row.id}:r`, columns: rest, rows: 1, cells: rasterCells(rest, colorAt, pillX + pillW) }))
    return parts
  }
  const parts = []
  let run = '', runProps = null, runKey = ''
  const flush = () => { if (run) { parts.push(h(Text, runProps, run)); run = '' } }
  for (let x = 0; x < cells; x++) {
    if (x === pillX) { flush(); parts.push(thumb); x += pillW - 1; continue }
    const c = colorAt(x)
    const key = c === null ? 'u' : c === -2 ? 'm' : toHex([(c >> 16) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255])
    const props = c === null ? { color: '#3a3a40' } : c === -2 ? { color: '#9a9aa0' } : { color: key }
    if (key !== runKey) { flush(); runKey = key; runProps = props }
    run += c === null ? '·' : c === -2 ? '│' : '▪'
  }
  flush()
  return parts
}

function progressSettled() {
  for (const r of progressRows.values()) if (Math.abs(r.target - r.shown) > 0.004) return false
  return true
}

// ---------------------------------------------------------------------------
// The Context pane (/tokens): the pack's own dashboard. One hue, our numbers, our animation.
const CONTEXT_PANE = 'context'
const BREAKDOWN_TTL = 10 * 1000     // $.session.usage({ breakdown: 'summary' }) is cached this long; redraws cost nothing
const CTX = { heading: '#e6e5dc', text: '#dcddd5', legend: '#b1afa6', secondary: '#84837d', dim: '#797773', tick: '#d4d3cf', mark: '#84837d',
  warm: '#ce9466', dot: '#e3883d', cold: '#8a8a90', track: '#2e2d29', cache: ['#629cde', '#a8a38c', '#da934b'] }
let ctxCache = { at: 0, usage: null }
let ctxLoading = null
let ctxBusy = false
let ctxMsg = ''
let ctxPaneOpen = false
let ctxExpanded = false
const SEG = { messages: '#4a7fe0', tools: '#d9792e', files: '#5aa05a', system: '#c9a227', buffer: '#6a6a70', free: '#2e2e33' }

/** 484000 → "484k", 1000000 → "1M", 1500000 → "1.5M". */
function fmtK(n) {
  if (!n || n < 0) return '0'
  if (n >= 999_500) {
    const m = n / 1_000_000
    const s = m >= 10 ? String(Math.round(m)) : m.toFixed(1).replace(/\.0$/, '')
    return s + 'M'
  }
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  return String(Math.round(n))
}

function pct100(x) {
  return Number.isFinite(x) ? Math.max(0, Math.min(100, Math.round(x))) : 0
}

/** Fold the breakdown's categories into the four groups the dialog shows, plus free space. */
function groupBreakdown(b) {
  const g = { system: 0, tools: 0, files: 0, messages: 0, free: 0, buffer: 0 }
  for (const c of (b && b.categories) || []) {
    const n = Number(c.tokens) || 0
    const name = String(c.name || '').toLowerCase()
    if (c.kind === 'free') g.free += n
    else if (c.kind === 'buffer') g.buffer += n
    else if (c.kind !== 'used') continue
    else if (/mcp/.test(name)) g.tools += n
    else if (/system|prompt/.test(name)) g.system += n
    else if (/memory|skill|file|command/.test(name)) g.files += n
    else if (/message/.test(name)) g.messages += n
    else g.files += n
  }
  return g
}

/** The pane's view model: context fill + breakdown, our thresholds, cache warmth, and what the pack saved. */
function contextView(usage, ttl, usageLast, clock, stats) {
  const ctx = (usage && usage.context) || {}
  const b = ctx.breakdown || null
  const window = Number(ctx.window) || (b && Number(b.rawMaxTokens)) || 0
  const used = b && Number.isFinite(b.totalTokens) ? b.totalTokens : Number.isFinite(ctx.tokens) ? ctx.tokens : sentOf(usageLast)
  const measure = (b && Number(b.rawMaxTokens)) || window || Math.max(used, 1)
  const pct = b && Number.isFinite(b.percentage) ? pct100(b.percentage) : Number.isFinite(ctx.percent) ? pct100(ctx.percent) : pct100((100 * used) / measure)
  const g = b ? groupBreakdown(b) : null
  const legend = g
    ? [['System', g.system], ['Tools', g.tools], ['Files', g.files], ['Messages', g.messages]].filter(([, n]) => n > 0).map(([label, tokens]) => ({ label, tokens }))
    : [{ label: 'Used', tokens: used }]
  const free = g ? g.free : Math.max(0, measure - used)
  const segments = (g
    ? [['messages', g.messages], ['tools', g.tools], ['files', g.files], ['system', g.system], ['buffer', g.buffer]]
    : [['messages', used]]).filter(([, n]) => n > 0).map(([id, tokens]) => ({ id, tokens, frac: Math.max(0, Math.min(1, tokens / measure)), color: SEG[id], ink: SEG_INK[id] }))
  let acc = 0
  for (const sg of segments) { acc += sg.frac; sg.end = acc }
  const compactOn = !!(b && b.isAutoCompactEnabled && Number.isFinite(b.autoCompactThreshold) && b.autoCompactThreshold > 0)
  const compactPct = compactOn ? pct100((100 * b.autoCompactThreshold) / measure) : null
  const nextMark = levels.map((l) => ({ pct: Number(l.pct), id: l.id })).filter((l) => l.pct > pct).sort((x, y) => x.pct - y.pct)[0] || null
  const marks = []
  if (compactPct !== null) marks.push({ frac: compactPct / 100, color: CTX.tick })
  if (nextMark) marks.push({ frac: nextMark.pct / 100, color: CTX.mark })
  const crossed = levels.filter((l) => Number(l.pct) <= pct).length
  const state = ['done', 'waiting', 'orange', 'failed'][Math.min(crossed, 3)]   // green until your first mark, then amber, orange, red
  const ttlMin = Math.max(1, Math.round(ttl / MINUTE))
  const sent = sentOf(usageLast)
  let cache
  if (!clock || !clock.known) {
    cache = { known: false, warm: false, accent: 'Cold', fill: 0, strong: 'no response yet', rest: '', foot: 'the clock starts after the first reply', footer: 'No response yet: the cache clock starts after the first reply.' }
  } else if (clock.warm) {
    const leftMin = Math.max(1, Math.round(clock.leftMs / MINUTE))
    cache = { known: true, warm: true, accent: 'Warm', fill: clock.leftMs / ttl, strong: `Warmth ${pct100((100 * clock.leftMs) / ttl)}%`, rest: ` · Hit ${hitPct(usageLast)}%`,
      foot: `${leftMin}m left of ${ttlMin}m`, footer: `Cache warm: next message reuses ${fmtK(sent)} from cache.` }
  } else {
    cache = { known: true, warm: false, accent: 'Cold', fill: 0, strong: 'Warmth 0%', rest: ` · Hit ${hitPct(usageLast)}%`,
      foot: `idle ${Math.max(1, Math.round(clock.idleMs / MINUTE))}m, past ${ttlMin}m`, footer: `Cache cold: next message re-caches ${fmtK(sent)}.` }
  }
  const saved = stats || {}
  const T = saved.totals || { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, keptOut: 0, vetoTokens: 0 }
  const limits = (usage && usage.rateLimits) || []
  const five = limits.find((r) => r.kind === 'five_hour')
  const hasCost = !!(usage && usage.cost && Number.isFinite(usage.cost.usd))
  const mode = hasCost ? 'api' : five ? 'subscription' : 'unknown'
  const inputAll = T.input + T.cacheRead + T.cacheWrite
  // API: the price per million input tokens, set in /config or derived from the engine's own ledger
  // (input 1×, cache write 1.25×, cache read 0.1×, output 5×: the pricing model's ratios)
  const billedUnits = T.input + 1.25 * T.cacheWrite + 0.1 * T.cacheRead + 5 * T.output
  const rate = Number(saved.rate) || (hasCost && billedUnits > 50_000 ? (usage.cost.usd / billedUnits) * 1e6 : 0)
  const cachePct = inputAll ? Math.round((100 * T.cacheRead) / inputAll) : 0
  const cacheSavedTok = Math.round(T.cacheRead * 0.9)
  const keptOutTok = T.keptOut
  const vetoTok = Math.round(T.vetoTokens * 1.25)
  const kw = saved.keepWarm || { pings: 0, savedTok: 0, costTok: 0 }
  const warmNet = kw.savedTok - kw.costTok                 // can be negative: pings you never came back for
  const totalSavedTok = cacheSavedTok + keptOutTok + vetoTok + warmNet
  const usd = (tok) => (mode === 'api' && rate ? `$${((tok * rate) / 1e6).toFixed(2)}` : '')
  // subscription: tokens per 1% of the five-hour window, learned as the window moves during this session
  const base = saved.limitBase
  const tokPerPct = base && five && five.percentUsed - base.pct >= 1 ? (inputAll - base.tokens) / (five.percentUsed - base.pct) : 0
  const win = (tok) => (mode === 'subscription' && tokPerPct > 0 ? `≈${Math.max(1, Math.round(tok / tokPerPct))}% of the 5-hour window` : '')
  const worth = (tok) => usd(tok) || win(tok)
  const headline = mode === 'api' && rate ? usd(totalSavedTok) : `${fmtK(totalSavedTok)} tok`
  const month = saved.month || null
  const savings = {
    mode, rate, totalTok: totalSavedTok, total: headline, totalWorth: mode === 'api' && rate ? `${fmtK(totalSavedTok)} tok` : worth(totalSavedTok),
    month: month && month.tok > totalSavedTok ? (mode === 'api' && rate ? usd(month.tok) : `${fmtK(month.tok)} tok`) : '',
    perTurn: T.turns ? (mode === 'api' && rate ? `${usd(Math.round(totalSavedTok / T.turns))} per turn` : `${fmtK(Math.round(totalSavedTok / T.turns))} tok per turn`) : '',
    lines: [
      `${fmtK(T.cacheRead)} served from cache, ${cachePct}% of input${worth(cacheSavedTok) ? ` · ${worth(cacheSavedTok)}` : ''}`,
      `${fmtK(Math.round(saved.savedChars / 4))} tok trimmed, kept out of ${T.turns} turn${T.turns === 1 ? '' : 's'} = ${fmtK(keptOutTok)}${worth(keptOutTok) ? ` · ${worth(keptOutTok)}` : ''}`,
      ...(kw.pings ? [`kept warm ${kw.pings}× · ${fmtK(kw.savedTok)} re-cache avoided − ${fmtK(kw.costTok)} spent pinging = ${warmNet < 0 ? '−' : ''}${fmtK(Math.abs(warmNet))}${worth(Math.abs(warmNet)) ? ` · ${worth(Math.abs(warmNet))}` : ''}`] : []),
      `${saved.rewrites} quiet command${saved.rewrites === 1 ? '' : 's'} · ${saved.vetoes} cold compact${saved.vetoes === 1 ? '' : 's'} vetoed${vetoTok ? ` (${fmtK(vetoTok)} re-cache avoided${worth(vetoTok) ? `, ${worth(vetoTok)}` : ''})` : ''}`,
    ],
    cost: hasCost ? `$${usage.cost.usd.toFixed(2)} spent` : five ? `${pct100(five.percentUsed)}% of 5-hour window used` : '',
    note: mode === 'api' ? (Number(saved.rate) ? `at $${Number(saved.rate).toFixed(2)}/M input (your rate)` : rate ? `at ≈$${rate.toFixed(2)}/M input, derived from this session's bill` : 'set $/M in /config for dollars')
        : mode === 'subscription' ? (tokPerPct > 0 ? 'subscription: savings shown as window headroom' : 'subscription: window maths appears once the 5-hour window moves') : 'tokens only',
  }
  // where tokens go: the categories with an action, biggest first
  const where = []
  if (g && g.tools > 20_000) where.push({ label: 'MCP tools', tokens: g.tools, tip: '/mcp, disable servers you do not use' })
  if (b && b.skills && Number(b.skills.tokens) > 3_000) where.push({ label: 'Skills', tokens: Number(b.skills.tokens), tip: '/loadout, park the ones you never call' })
  if (g && g.messages > 0) where.push({ label: 'Messages', tokens: g.messages, tip: pct >= 50 ? '/handoff then /clear before the next topic' : 'one task per session; /clear on a topic change' })
  if (g && g.files > 30_000) where.push({ label: 'Files', tokens: g.files, tip: 'memory files and skills load every turn; trim CLAUDE.md' })
  where.sort((x, y) => y.tokens - x.tokens)
  const tips = []
  if (clock && clock.known && !clock.warm) tips.push('cache is cold: /clear beats /compact, which would re-cache everything')
  if (clock && clock.known && clock.warm && hitPct(usageLast) < 70) tips.push(`cache hit ${hitPct(usageLast)}%: avoid editing CLAUDE.md, settings or /model mid-session`)
  if (nextMark) tips.push(`next mark ${nextMark.pct}% (${nextMark.id}): ${nextMark.id === 'handoff' ? 'write a handoff and /clear' : nextMark.id === 'compact' ? '/compact only while the cache is warm' : 'note decisions as you go'}`)
  const savedStrong = savings.total
  const savedRest = savings.totalWorth ? ` · ${savings.totalWorth}` : ''
  const hint = hintFor(pct, clock || { warm: false, leftMs: 0 })
  return {
    hasData: !!usage, pct, used, window, measure, state,
    header: { usedText: window ? `${fmtK(used)} / ${fmtK(window)} (${pct}%)` : `${fmtK(used)} (${pct}%)`, compactText: compactPct === null ? '' : `Compact at ${compactPct}%` },
    marks, legend, free, segments, nextMark, compactPct, cache, savedStrong, savedRest, savings, where: where.slice(0, 3), tips: tips.slice(0, 2), hint,
  }
}

function toast($, text, timeoutMs = 6000) {
  try { $.ui.toast(text, { timeoutMs }) } catch { /* no UI */ }
}

function invalidate($) {
  try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
}

/** The pane's figures: one usage call with the summary breakdown (never 'full': that sends token-count requests), cached 10 s. */
/** The context window bar: one rounded track, a rect per category, the free space as the track. */
function stackedBarSvg(segments, width, height = 8) {
  const W = Math.max(60, Math.round(width)), H = height
  let x = 0, rects = ''
  for (const sg of segments) { const w = sg.frac * W; if (w >= 0.5) rects += `<rect x="${x.toFixed(1)}" width="${w.toFixed(1)}" height="${H}" fill="${sg.color}"/>`; x += w }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><clipPath id="cstack"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath></defs><rect width="${W}" height="${H}" rx="${H / 2}" fill="${SEG.free}"/><g clip-path="url(#cstack)">${rects}</g></svg>`
}
function stackedBarText(h, Text, segments, cells) {
  const parts = []
  let used = 0
  for (const sg of segments) { const n = Math.round(sg.frac * cells); if (n > 0) { parts.push(h(Text, { color: sg.color }, '█'.repeat(n))); used += n } }
  if (cells - used > 0) parts.push(h(Text, { color: '#3a3a40' }, '░'.repeat(cells - used)))
  return parts
}

/** The dialog's cache bar: a rounded track, the fill a blue → grey → orange gradient. */
function gradientBarSvg(fill, width, height = 10, id = 'g') {
  const W = Math.max(40, Math.round(width)), H = height, f = Math.max(0, Math.min(1, fill)) * W
  const [a, b, c] = CTX.cache
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><linearGradient id="${id}" x1="0" x2="1"><stop offset="0" stop-color="${a}"/><stop offset="0.5" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient><clipPath id="c${id}"><rect width="${W}" height="${H}" rx="${H / 2}"/></clipPath></defs><rect width="${W}" height="${H}" rx="${H / 2}" fill="${CTX.track}"/><g clip-path="url(#c${id})"><rect width="${f.toFixed(1)}" height="${H}" fill="url(#${id})"/></g></svg>`
}
function gradientBarText(h, Text, fill, cells) {
  const n = Math.round(Math.max(0, Math.min(1, fill)) * cells), parts = []
  const [a, b, c] = CTX.cache
  const third = Math.max(1, Math.round(n / 3))
  if (n > 0) parts.push(h(Text, { color: a }, '█'.repeat(Math.min(n, third))))
  if (n > third) parts.push(h(Text, { color: b }, '█'.repeat(Math.min(n - third, third))))
  if (n > 2 * third) parts.push(h(Text, { color: c }, '█'.repeat(n - 2 * third)))
  if (cells - n > 0) parts.push(h(Text, { color: CTX.track }, '░'.repeat(cells - n)))
  return parts
}

/** Carry this session's savings into a per-month total in $.store, adding only what is new since the last roll. */
async function rollMonth($) {
  try {
    const key = `saved:${new Date().toISOString().slice(0, 7)}`
    const sessionTok = Math.round(totals.cacheRead * 0.9) + totals.keptOut + Math.round(totals.vetoTokens * 1.25) + keepWarm.savedTok - keepWarm.costTok
    const delta = sessionTok - monthSaved.sessionTok
    if (monthSaved.key !== key) { const prev = await $.store.get(key); monthSaved = { key, tok: Number(prev && prev.tok) || 0, usd: 0, sessionTok: 0, sessionUsd: 0 } }
    monthSaved.tok += Math.max(0, delta)
    monthSaved.sessionTok = sessionTok
    await $.store.set(key, { tok: monthSaved.tok })
  } catch { /* no store */ }
}

async function loadContext($, now, columns) {
  if (ctxCache.at && now - ctxCache.at < BREAKDOWN_TTL) return ctxCache
  if (ctxLoading) return ctxLoading
  ctxLoading = (async () => {
    let usage = null
    try {
      usage = await $.session.usage({ breakdown: 'summary', columns })
    } catch {
      try { usage = await $.session.usage() } catch { usage = null }
    }
    ctxCache = { at: now, usage }
    return ctxCache
  })().finally(() => { ctxLoading = null })
  return ctxLoading
}

/** /clear from the pane: $.command.run is the documented route for a plugin; where it is missing, say so, never fake it. */
async function clearSession($) {
  try { await $.ui.close({ id: CONTEXT_PANE }) } catch { /* already closed */ }
  try {
    // Rejects on a build without command.run or one that refuses `clear`; then the person types it.
    await $.command.run({ command: 'clear' })
  } catch (err) {
    toast($, `token-saver: could not run /clear (${err && err.message ? err.message : String(err)}) — type /clear`)
  }
}

/** Compact from the pane: the mod's own guard (cold cache → veto, keep-list) applies as it does to a typed /compact. */
async function compactNow($, ttl, compactGuard) {
  if (ctxBusy) return
  ctxBusy = true
  ctxMsg = 'compacting…'
  invalidate($)
  try {
    const clock = cacheClock(await $.clock.now(), ttl)
    if (compactGuard && clock.known && !clock.warm) {
      vetoes += 1
      const ctx = await contextOf($)
      ctxMsg = `compact vetoed: cache cold (idle ${mins(clock.idleMs)}m), it would re-send ~${fmt(ctx.tokens)} tokens. Prefer /handoff then /clear; /compact force overrides.`
    } else {
      const r = await $.session.compact({})
      if (r && r.skip) ctxMsg = `compact skipped: ${r.skip}`
      else if (r && Number.isFinite(r.tokensBefore)) ctxMsg = `compacted ${fmtK(r.tokensBefore)} → ${Number.isFinite(r.tokensAfter) ? fmtK(r.tokensAfter) : '?'}`
      else ctxMsg = 'compacted'
    }
  } catch (err) {
    ctxMsg = `compact failed: ${err && err.message ? err.message : String(err)}`
  }
  ctxBusy = false
  ctxCache.at = 0
  toast($, `token-saver: ${ctxMsg}`, 8000)
  invalidate($)
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
  const inputPricePerM = Number(options.inputPricePerM) || 0
  const suggestSkills = options.suggestSkills !== false
  const ttl = options.longCacheTtl ? TTL_LONG : TTL_SHORT
  // Keep-warm pings only make sense against the 5-minute TTL; with the 1-hour TTL a lapse is already rare
  const keepWarmMax = Math.max(0, Math.round(Number(options.keepWarmPings ?? 5)))
  keepWarm.on = options.keepWarm !== false && !options.longCacheTtl && keepWarmMax > 0

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
        description: 'Context pane: window fill, rate limits, cache warmth, Clear / Compact. /tokens list prints it as text. No model turn.',
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
      progressTick += 1
      const moving = !progressSettled()
      const tNow = progressTick * TICK_S
      const animating = [...progressRows.values()].some((r) =>
        r.state === 'running' || r.state === 'waiting' || (r.state === 'done' && tNow - (r.settledAt || 0) < SH.sparkleFor + SH.MAX_AGE))
      if (moving) for (const r of progressRows.values()) r.shown += (r.target - r.shown) * 0.16
      // the shader runs at the tick rate while a row is live or a finished one still sparkles; afterwards a row costs nothing
      if (changed || moving || animating || (ctxPaneOpen && progressTick % 2 === 0)) {
        try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
      }
    })
    if (cacheBand) {
      // Keeps "warm Nm" honest while the person thinks. Runs until the module reloads.
      $.clock.every(BAND_TICK, () => {
        if (lastStepAt) $.ui.invalidate('ui.render')
      })
    }
    if (keepWarm.on) $.clock.every(KEEP_WARM_TICK, () => { tickKeepWarm($, ttl, keepWarmMax).catch(() => { keepWarm.busy = false }) })
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
    if (arg === '' || arg === 'pane') {
      // The Context pane: the engine's own context dialog, drawn by the mod. Text where panes do not draw (vscode).
      ctxCache.at = 0
      try {
        const opened = await $.ui.open({ id: CONTEXT_PANE, title: 'Context', focus: true, closeOnEscape: true, holdToasts: true, rows: 10 })
        if (!opened || opened.isPlaced !== false) {
          ctxMsg = ''
          ctxPaneOpen = true
          await rollMonth($)
          return { text: 'Context pane opened. Esc closes it. /tokens list prints the same as text.' }
        }
      } catch {
        /* no panes on this surface: the text answer below */
      }
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
        `keep-warm     ${keepWarm.on ? `on · ${keepWarm.pings} ping${keepWarm.pings === 1 ? '' : 's'} · avoided ${fmt(keepWarm.savedTok)} · spent ${fmt(keepWarm.costTok)} tok` : `off${keepWarm.stopped ? ` (${keepWarm.stopped})` : ''}`}`,
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
        const opened = await $.ui.open({ id: SKILLS_PANE, title: 'Loadout', focus: true, closeOnEscape: true, holdToasts: true })
        if (!opened || opened.isPlaced !== false) return { text: 'Loadout pane opened. Esc closes it. /loadout list prints the same as text.' }
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
    return { result: text }
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

  // Keep-warm never pings while a turn runs: the turn itself keeps the cache warm, and a fork would race it
  on('turn.start', async ($, e, next) => {
    inTurn = true
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      inTurn = false
    }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (!e.agentId && result && result.usage) {
      const stepAt = await $.clock.now()
      // Kept warm through an idle stretch that would have lapsed, and this request hit: the re-write was avoided
      if (keepWarm.streak > 0 && lastStepAt && stepAt - lastStepAt >= ttl && stepAt - keepWarm.refreshedAt < ttl && hitPct(result.usage) >= 80) {
        keepWarm.savedTok += Math.round(1.15 * (result.usage.cache_read_input_tokens || 0))
      }
      keepWarm.streak = 0
      lastUsage = result.usage
      lastStepAt = stepAt
      totals.turns += 1
      totals.input += result.usage.input_tokens || 0
      totals.cacheRead += result.usage.cache_read_input_tokens || 0
      totals.cacheWrite += result.usage.cache_creation_input_tokens || 0
      totals.output += result.usage.output_tokens || 0
      totals.keptOut += Math.round(savedChars / 4)          // every trimmed token would have been resent this turn
      try {
        const u = await $.session.usage()
        const five = (u && u.rateLimits || []).find((r) => r.kind === 'five_hour')
        if (five && !limitBase) limitBase = { pct: five.percentUsed, tokens: totals.input + totals.cacheRead + totals.cacheWrite }
      } catch { /* no usage API */ }
      if (totals.turns % 10 === 0) await rollMonth($)
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
        totals.vetoTokens += ctx.tokens || 0
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

  /**
   * The Context pane. Top to bottom: header (title, fill, stacked bar, compaction mark), legend, four cards
   * (session, weekly, model, cache), footer (cache line, Clear / Compact / Later). Svg bars where the surface
   * has Svg, glyph runs on the terminal. Figures from loadContext(), cached 10 s.
   */
  on('ui.close', ($, e, next) => {
    if (e && e.id === CONTEXT_PANE) ctxPaneOpen = false
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: CONTEXT_PANE }, async ($, e) => {
    try {
    const el = $.ui.resolve(e)
    const { Box, Text, Button } = el
    const Svg = e.surface === 'terminal' ? undefined : el.Svg
    const Raster = e.surface === 'terminal' ? el.Raster : undefined
    const W = (e.props && e.props.bodyColumns) || (e.viewport && e.viewport.columns) || 80
    const now = await $.clock.now()
    const data = await loadContext($, now, W)
    const view = contextView(data.usage, ttl, lastUsage, cacheClock(now, ttl), { rewrites, savedChars, vetoes, totals, rate: inputPricePerM, limitBase, month: monthSaved, keepWarm })
    const PX = 6.5
    const col = (props, children) => h(Box, { flexDirection: 'column', ...props }, ...children)
    const row = (props, children) => h(Box, { flexDirection: 'row', ...props }, ...children)
    const t = (str, props) => h(Text, props || null, str)
    const dim = (str) => h(Text, { color: CTX.dim }, str)
    const sec = (str) => h(Text, { color: CTX.secondary }, str)
    const bar = (rowObj, cells, marks, alt) =>
      Svg
        ? h(Svg, { source: progressSvg(rowObj, cells * PX, marks), alt, height: BAR_H })
        : row({}, progressTrackText(rowObj, cells, h, Text, Raster, marks))

    // Collapsed: ◔ Context window … 818.6k / 1M (82%) ›   then the stacked bar
    const headline = row({ alignItems: 'center', gap: 1 }, [
      t('◔ ', { color: CTX.secondary }),
      t('Context window', { bold: true, color: CTX.heading }),
      h(Box, { flexGrow: 1 }),
      ...(view.savings.totalTok ? [t(`saved ${view.savings.total}`, { color: CTX.warm }), dim(' · ')] : []),
      sec(view.header.usedText),
      h(Button, { key: 'ctx-expand', label: ctxExpanded ? '⌄' : '›', plain: true, hotkey: 'e', onPress: () => { ctxExpanded = !ctxExpanded; invalidate($) } }),
    ])
    const barCols = Math.max(12, W - 4)
    const ctxRow = { id: 'context', label: 'Context', stage: `${view.pct}%`, step: 0, total: 0, state: view.state, live: true, plain: true, target: view.pct / 100, shown: view.pct / 100, note: '' }
    const stacked = bar(ctxRow, barCols, view.marks, `Context ${view.pct}%`)
    if (!ctxExpanded) return col({ gap: 0 }, [headline, stacked, ...(ctxMsg ? [dim(ctxMsg)] : [])])

    // Expanded: the cells recolour by category, the cache bar under it, then the figures in two text columns
    const splitRow = { ...ctxRow, id: 'context-split', segments: view.segments }
    const cacheRow = { id: 'cache', label: 'Cache', stage: view.cache.pill || '', step: 0, total: 0, state: view.cache.warm ? 'running' : 'cold', plain: true, target: view.cache.fill, shown: view.cache.fill, note: '', settledAt: 0 }
    const bars = col({ gap: 0 }, [
      bar(splitRow, barCols, view.marks, `Context ${view.pct}% by category`),
      row({}, [t('Cache', { bold: true, color: CTX.heading }), t(' · ', { color: CTX.dim }), t(view.cache.accent, { bold: true, color: view.cache.warm ? CTX.warm : CTX.dim }),
        dim('   '), t(view.cache.strong, { bold: true, color: CTX.text }), sec(view.cache.rest), dim(` · ${view.cache.foot}`)]),
      ...(view.cache.known ? [bar(cacheRow, barCols, [], `Cache ${view.cache.accent}`)] : []),
    ])
    const savedBlock = col({ gap: 0 }, [
      row({}, [t('Saved this session  ', { bold: true, color: CTX.heading }), t(view.savedStrong, { bold: true, color: CTX.warm }), sec(view.savedRest),
        ...(view.savings.perTurn ? [dim(` · ${view.savings.perTurn}`)] : []), ...(view.savings.month ? [dim(` · ${view.savings.month} this month`)] : []), ...(view.savings.cost ? [dim(` · ${view.savings.cost}`)] : [])]),
      ...view.savings.lines.map((l) => t(l, { color: CTX.legend, wrap: 'wrap' })),
      dim(view.savings.note),
    ])
    const whereBlock = view.where.length
      ? col({ gap: 0 }, [
          t(' '),
          t('Where tokens go', { bold: true, color: CTX.heading }),
          ...view.where.map((w) => row({}, [t(`${w.label} `, { color: CTX.legend }), t(`${fmtK(w.tokens)} `, { bold: true, color: CTX.text }), dim('every turn → '), t(w.tip, { color: CTX.legend, wrap: 'wrap' })])),
          ...view.tips.map((tip) => row({}, [t('→ ', { color: CTX.warm }), t(tip, { color: CTX.legend, wrap: 'wrap' })])),
        ])
      : col({}, view.tips.map((tip) => row({}, [t('→ ', { color: CTX.warm }), t(tip, { color: CTX.legend, wrap: 'wrap' })])))
    const footer = row({ alignItems: 'center', gap: 1 }, [
      t('●', { color: view.cache.warm ? CTX.dot : CTX.dim }),
      t(view.cache.footer, { color: CTX.text }),
    ])
    const buttons = row({ gap: 1 }, [
      h(Button, { key: 'ctx-clear', label: 'Clear', hotkey: 'c', variant: 'primary', onPress: () => clearSession($) }),
      h(Button, { key: 'ctx-compact', label: ctxBusy ? 'Compacting…' : 'Compact', hotkey: 'k', onPress: () => compactNow($, ttl, compactGuard) }),
      h(Button, { key: 'ctx-later', label: 'Later', hotkey: 'l', role: 'dismiss', onPress: async () => { ctxPaneOpen = false; try { await $.ui.close({ id: CONTEXT_PANE }) } catch { /* closed */ } } }),
    ])
    return col({ gap: 0 }, [
      headline,
      bars,
      t(' '),
      savedBlock,
      whereBlock,
      t(' '),
      footer,
      buttons,
      ...(ctxMsg ? [dim(ctxMsg)] : []),
    ])
    } catch (err) {
      const { Text } = $.ui.resolve(e)
      return h(Text, { color: '#e5484d' }, `token-saver: context pane failed: ${err && err.stack ? err.stack.split('\n').slice(0, 2).join(' ') : String(err)}`)
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props && e.props.hasSurvey) return next(e)
    const showTokens = cacheBand && lastUsage && !bandHidden
    if (progressRows.size === 0 && !showTokens) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const Svg = $.ui.resolve(e).Svg
    const Raster = e.surface === 'terminal' ? $.ui.resolve(e).Raster : undefined
    const width = (e.props && e.props.bodyColumns) || (e.viewport && e.viewport.columns) || 80
    const children = []
    for (const row of progressRows.values()) {
      const pct = `${Math.round(row.shown * 100)}%`.padStart(4)
      const labelW = Math.min(28, Math.max(10, row.label.length))
      const close = h(Button, { key: `progress-close:${row.id}`, label: '×', plain: true, onPress: () => {
        progressRows.delete(row.id)
        try { $.ui.status(progressRows.size ? 'Progress' : undefined); $.ui.invalidate('ui.render') } catch { /* no UI */ }
      } })
      const lead = [h(Text, null, row.label.slice(0, labelW).padEnd(labelW) + '  ')]
      if (Svg && e.surface !== 'terminal') {
        const barPx = Math.max(180, Math.min(420, (width - labelW - 14) * 7))
        children.push(h(Box, { flexDirection: 'row', alignItems: 'center', gap: 1 }, ...lead,
          h(Svg, { source: progressSvg(row, barPx), alt: `${row.label}: ${pillText(row)}, ${pct.trim()}`, height: BAR_H }),
          h(Text, { dimColor: true }, ` ${pct} `), close))
      } else {
        const cells = Math.max(16, Math.min(48, width - labelW - 16))
        children.push(h(Box, { flexDirection: 'row' }, ...lead, ...progressTrackText(row, cells, h, Text, Raster), h(Text, { dimColor: true }, ` ${pct} `), close))
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
