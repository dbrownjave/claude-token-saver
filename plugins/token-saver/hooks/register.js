/**
 * Token-saver mod. In-process plugin of function hooks.
 *
 * Sandbox rules: a hooks module may import only its own files and
 * "claude-code". No node:* imports, no process/env globals. Files go through
 * $.fs, environment through $.env, time through $.clock.
 *
 * VS Code's chat panel runs these hooks but does not draw UI.
 */

import { GLOSSARY } from './glossary.js'

const LIMIT = 8000
const HEAD = 2500
const TAIL = 1500
const MINUTE = 60 * 1000
const TTL_SHORT = 5 * MINUTE
const TTL_LONG = 60 * MINUTE
const SWITCH_CHEAP = 20_000              // a model switch under this many context tokens gets a toast, not a dialog
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
let bandSurface = 'terminal'      // where the band last drew: the desktop's native buttons drop a press that spans a redraw
const totals = { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, keptOut: 0, vetoTokens: 0, switchHeld: 0, switchPaid: 0, oneShot: 0, agentLapses: 0, agentLapseTok: 0 }   // this session, from turn.step usage
/**
 * Subagent cache lapses. Every subagent request gets the 5-minute cache TTL, even where the main thread has an hour.
 * An agent that idles past 5 minutes mid-run (a test suite, a build, a CI wait) re-writes its whole context at 1.25×
 * on its next step. The mod cannot set a TTL; it measures the lapses and says which agent file would pay for
 * `experimental.cacheTtl: 1h` (writes at 2× instead of 1.25×, so only agents that actually lapse come out ahead).
 *  - `agents`: the running ones, agentId → record; dropped when the agent answers
 *  - `agentTypes`: this session's sums per agent type (Explore, Plan, …), what the pane and /tokens read
 *  - `$.store` `lapses:<type>`: week and lifetime counts, so a line can say "3 times this week"
 */
const agents = new Map()        // agentId → { type, model, lastStepAt, lapses, lapseWrite, otherWrite, steps }
const agentTypes = new Map()    // type → { lapses, lapseWrite, otherWrite, runs }
let agentWeeks = {}             // type → weekCount, read from $.store once per loadContext
const LAPSE_RE = 1.15           // a lapse write at 1.25× that a longer cache would have made a hit at 0.1×
const LONG_PREMIUM = 0.75       // what every other write would have cost extra at the 1-hour price (2× − 1.25×)
let oneShot = null              // { model } while the next main-thread turn goes to another model and the session stays put
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

/** 'claude-opus-5-5' → 'Opus 5.5'; an alias or unknown id is shown as given. */
function modelName(id) {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(String(id || ''))
  if (!m) return String(id || 'the other model')
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
}

/** How this session pays: API dollars, or a subscription's 5-hour window (tokens per % of it, once the window has moved). */
async function billing($) {
  let u = null
  try { u = await $.session.usage() } catch { /* no usage API */ }
  const priced = !!(u && u.cost && Number.isFinite(u.cost.usd))
  const five = (u && u.rateLimits || []).find((r) => r.kind === 'five_hour') || null
  const inputAll = totals.input + totals.cacheRead + totals.cacheWrite
  const tokPerPct = limitBase && five && five.percentUsed - limitBase.pct >= 1 ? (inputAll - limitBase.tokens) / (five.percentUsed - limitBase.pct) : 0
  return { priced, tokPerPct }
}

/**
 * A subscription on usage credits: a five-hour window exists and is either spent (100%) or billed beside (a dollar
 * cost next to a window). A plain API key has no five-hour window. The engine ignores a 1-hour subagent cacheTtl
 * while on credits, so the recommendation is not made there; the measurements still are.
 */
function onCredits(usage) {
  const five = (usage && usage.rateLimits || []).find((r) => r.kind === 'five_hour') || null
  if (!five) return false
  return Number(five.percentUsed) >= 100 || !!(usage.cost && Number.isFinite(usage.cost.usd))
}

/** ISO week key, UTC: 2026-W41. */
function isoWeek(ms) {
  const d = new Date(ms)
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = day.getUTCDay() || 7
  day.setUTCDate(day.getUTCDate() + 4 - dow)
  const jan1 = new Date(Date.UTC(day.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((day - jan1) / 86_400_000 + 1) / 7)
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** A finished subagent run folds into its type's session sums; a run that lapsed also rolls into the store's week count. */
async function rollAgent($, rec) {
  const t = agentTypes.get(rec.type) || { lapses: 0, lapseWrite: 0, otherWrite: 0, runs: 0 }
  t.lapses += rec.lapses; t.lapseWrite += rec.lapseWrite; t.otherWrite += rec.otherWrite; t.runs += 1
  agentTypes.set(rec.type, t)
  if (!rec.lapses) return
  try {
    const key = `lapses:${rec.type}`, weekKey = isoWeek(await $.clock.now())
    const prev = (await $.store.get(key)) || {}
    const sameWeek = prev.weekKey === weekKey
    const next = {
      weekKey, weekCount: (sameWeek ? Number(prev.weekCount) || 0 : 0) + rec.lapses, weekTok: (sameWeek ? Number(prev.weekTok) || 0 : 0) + Math.round(rec.lapseWrite * 1.25),
      allCount: (Number(prev.allCount) || 0) + rec.lapses, allTok: (Number(prev.allTok) || 0) + Math.round(rec.lapseWrite * 1.25),
    }
    await $.store.set(key, next)
    agentWeeks[rec.type] = next.weekCount
  } catch { /* no store */ }
}

/** Week counts per agent type from the store, for "lapsed 3 times this week". */
async function loadAgentWeeks($, now) {
  const out = {}
  try {
    const weekKey = isoWeek(now)
    for (const key of await $.store.keys()) {
      if (!key.startsWith('lapses:')) continue
      const v = await $.store.get(key)
      if (v && v.weekKey === weekKey) out[key.slice(7)] = Number(v.weekCount) || 0
    }
  } catch { /* no store */ }
  return out
}

/** One question, 2-4 labels: `$.ui.ask` where the engine has it, else the AskUserQuestion tool call it stands for. Rejects when dismissed. */
async function askUser($, question, labels, header) {
  try {
    return await $.ui.ask(question, { options: labels, header })
  } catch (err) {
    if (!(err instanceof TypeError)) throw err                     // dismissed, or a -p run: the caller's business
  }
  // an engine without $.ui.ask: the AskUserQuestion tool call it stands for (the tool's arguments sit beside `tool`)
  const r = await $.tool.call({ tool: 'AskUserQuestion', questions: [{ question, header, options: labels.map((l) => ({ label: l, description: l })), multiSelect: false }] })
  if (!r || r.deny) throw new Error((r && r.deny) || 'dismissed')
  const answers = r.result && r.result.answers
  const v = answers && (answers[question] !== undefined ? answers[question] : Object.values(answers)[0])
  if (typeof v !== 'string') throw new Error('dismissed')
  return v
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
const LOOP_DT = 2 * TICK_S       // desktop: a bar's own loop holds a frame this long (the desktop drew every other tick)
const LOOP_N = 21                // ... and this many frames: 2.94 s, one period of the calm pulse, so the loop closes

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
// The Context pane (/tokens): the pack's own dashboard, drawn to the M4 design (design/m4.js). Closed: the title with
// the fill, the context bar (F1 fire, ink in the threshold colour), the cache and saved line, Clear / Compact / Later.
// Open: what was saved, three cards (next mark, billing, cache), Claude's working memory by kind, drill-down groups.
const CONTEXT_PANE = 'context'
const BREAKDOWN_TTL = 10 * 1000     // $.session.usage({ breakdown: 'summary' }) is cached this long; redraws cost nothing
let ctxCache = { at: 0, usage: null }
let ctxLoading = null
let ctxBusy = false
let ctxMsg = ''
let ctxPaneOpen = false
let ctxExpanded = false
let ctxReceipt = false
let ctxPopped = false            // desktop: the Pane was opened by the band's ⤢ (cleared when it closes)
const ctxGroups = new Set()          // which drill-down groups are open
let homeCache = null                 // $HOME, read once, to shorten memory-file paths
/** Context added per message: tokens at turn.complete less tokens at turn.start, the last five. */
const growth = []
let turnStartTokens = null
const GROWTH_KEEP = 5

/** Threshold colour by marks crossed: calm blue, then amber, Claude orange, red. Theme keys for Text. */
const ACC = ['permission', 'warning', 'claude', 'error']
/** The same theme keys as hex, per surface (design/theme/claude-themes.json, dark), for the bars' ink. */
const THEME_HEX = {
  terminal: { permission: '#b1b9f9', warning: '#ffc107', claude: '#d77757', error: '#ff6b80', success: '#4eba65', text: '#ffffff', inactive: '#999999', subtle: '#505050' },
  desktop: { permission: '#74abe2', warning: '#fab219', claude: '#d97757', error: '#dd5353', success: '#65bb30', text: '#faf9f5', inactive: '#9c9a92', subtle: '#4a4945' },
}
const CACHE_GRAD = ['#629cde', '#a8a38c', '#da934b']
const CACHE_TRACK = '#2e2d29'
const WARM = '#ce9466'
const COLD = '#629cde'
const BAR_TRACK = '#2a2a2e'
const BUFFER_CELL = '#45454b'
// Desktop: the pane's ground lifted 7% toward the text, and the buffer 30% on toward faint, as design/m4.html draws them
const DESK_TRACK = '#353533'
const DESK_BUFFER = '#545350'
const MARK_TICK = '#c2c0b6'
const AUTO_TICK = '#7d7b75'
/** Claude's working memory: one family around Claude's orange, so it never reads as a signal colour. */
const MEM = { messages: '#e07a52', mcp: '#f2a07b', skills: '#c6613f', system: '#f6c9a8', tools: '#9e9a97', memory: '#b98b72', agents: '#d9a888', other: '#a8968a', buffer: '#64635e', free: '#46453f' }
const MEM_RANK = ['messages', 'mcp', 'skills', 'system', 'tools', 'memory', 'agents', 'other']
const BAR_PAD = 8                   // desktop: px of air above and below the context bar, as design/m4.html's 10 px gaps
const INNER_PAD = 5                 // desktop: the same air, smaller, for the Saved, card and memory bars inside the open pane
const PX = 7.8                      // desktop px per body column (the band measured 523 pt over 66 columns: 7.9)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

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

const cap1 = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const rgb01 = (hex) => hexRgb(hex).map((v) => v / 255)
const mixHex = (a, b, t) => toHex(mix3(rgb01(a), rgb01(b), t))
const gradAt = (f) => (f < 0.5 ? mixHex(CACHE_GRAD[0], CACHE_GRAD[1], f / 0.5) : mixHex(CACHE_GRAD[1], CACHE_GRAD[2], (f - 0.5) / 0.5))
const avgGrowth = () => (growth.length ? growth.reduce((a, b) => a + b, 0) / growth.length : 0)
function crossedAt(p) {
  return Math.min(3, levels.filter((l) => Number(l.pct) <= p).length)
}
function seedOf(s) {
  let x = 7
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) % 997
  return x
}

// ---- F1 "Comet", ported from design/fire/F1.js: a white-hot core at the head, a flickering body, wind-blown
// tongues and embers carried left, cooling white → hot → c0 → c1 into a calm bed. Pure: a frame is a function of t.
const FC = {
  CORE: 2.2, NOSE: 1.5, ZONE: 175, BODY_LEN: 17, TONGUE_LEN: 80, WIND: 170, BODY_CELL: 7, TONGUE_CELL: 30,
  EMBER_GAP: 0.018, EMBER_V_LO: 150, EMBER_V_HI: 310, EMBER_D_LO: 30, EMBER_D_HI: 165, EMBER_SPREAD: 1.6, STREAK: 1.1, TICK: 0.07,
  BED_LO: 0.55, BED_HI: 0.86,
}
const WHITE = [1, 1, 1]
function mix3(a, b, t) {
  return [mixN(a[0], b[0], t), mixN(a[1], b[1], t), mixN(a[2], b[2], t)]
}
function vnoise(u, row) {
  const i = Math.floor(u), f = u - i, s = f * f * (3 - 2 * f)
  return mixN(hash21(i, row), hash21(i + 1, row), s)
}
/** The heat ramp: 0 is the bed (or the track ahead), then c1, c0, hot, white, in four even steps. */
function f1Ramp(h, base, ink) {
  if (h <= 0) return base
  if (h >= 1) return WHITE
  const k = h * 4, i = Math.floor(k), f = k - i
  const stops = [base, ink.c1, ink.c0, ink.hot, WHITE]
  return mix3(stops[i], stops[i + 1], f)
}
/** A bar for the shader. `ink` from one colour: hot = toward white, c0 = itself, c1 = toward black. */
function inkOf(hex) {
  const c = rgb01(hex)
  return { hot: mix3(c, WHITE, 0.45), c0: c, c1: mix3(c, [0, 0, 0], 0.35) }
}
function fireBar(geo, shown, live, seed, ink, trackHex) {
  const s = Math.max(Math.min(shown, 1), 0.02)
  return { W: geo.W, H: geo.H, rows: geo.rows, pitch: geo.pitch, cols: geo.cols, shown: s, head: s * geo.W, live, seed, wind: 1, ink, track: rgb01(trackHex) }
}
function f1Frame(bar, t) {
  const { W, pitch, rows, cols, head, live, seed } = bar
  const U = Math.sqrt((W * pitch) / (826 * 3.5))
  const wind = Math.max(bar.wind ?? 1, 0.05)
  const hc = Math.max(0, Math.round(head / pitch - 0.5))
  const zone = FC.ZONE * U
  const lo = Math.max(0, Math.floor((head - zone) / pitch)), hi = Math.min(cols - 1, hc + 2)
  const n = Math.max(0, hi - lo + 1)
  const heat = new Float32Array(rows * n)
  const mid = (rows - 1) / 2
  const pulse = live ? 0.93 + 0.07 * Math.sin(t * 23 + seed) * Math.sin(t * 9.7) : 0.5 + 0.08 * Math.sin(t * 2.1)
  const drift = live ? FC.WIND * U * wind * t : 0
  for (let cy = 0; cy < rows; cy++) {
    const off = Math.abs(cy - mid) / Math.max(mid, 1)
    const rowK = 1 - 0.35 * off
    for (let cx = lo; cx <= hi; cx++) {
      const p = (cx + 0.5) * pitch, d = head - p
      let h
      if (d < -0.5 * pitch) {
        h = d >= -FC.NOSE * pitch ? (live ? 0.8 : 0.5) * pulse * (1 - 0.7 * off) : 0
      } else if (d <= FC.CORE * pitch) {
        h = live ? (d < 0.3 * pitch ? 1 - 0.12 * off : 1) * pulse + 0.05 : 0.62 + pulse * 0.2
      } else {
        const du = d / U
        const u = (p + drift) / U
        const flick = vnoise(u / FC.BODY_CELL, cy * 7.3 + seed)
        const body = Math.exp(-(du - (FC.CORE * pitch) / U) / (FC.BODY_LEN * rowK)) * (live ? 0.62 + 0.5 * flick : 0.75)
        let tongue = 0
        if (live) {
          const tn = vnoise((u + (1.3 * drift) / U) / FC.TONGUE_CELL, cy * 3.1 + seed * 0.37)
          const s = clamp01((tn - 0.48) / 0.3)
          tongue = s * s * Math.exp(-du / (FC.TONGUE_LEN * rowK)) * 1.2
        }
        h = Math.max(body, tongue)
      }
      heat[cy * n + (cx - lo)] = Math.min(h, 1)
    }
  }
  if (live) {
    const span = FC.EMBER_D_HI / FC.EMBER_V_LO / wind
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
}
function f1Shade(cx, cy, bar, s) {
  const { pitch, head, ink, track } = bar
  const p = (cx + 0.5) * pitch
  const h = cx >= s.lo && cx <= s.hi ? s.heat[cy * s.n + (cx - s.lo)] : 0
  if (p > head + 0.5 * pitch) return h <= 0 ? null : f1Ramp(h, track, ink)
  const g = Math.min(p / Math.max(head, 1), 1)
  const a = mixN(FC.BED_LO, FC.BED_HI, g) * (0.94 + 0.06 * hash21(cx, cy + bar.seed))
  const bed = mix3(track, mix3(ink.c1, ink.c0, 0.3 * g * g), a)
  return f1Ramp(h, bed, ink)
}
/** The head's soft glow: one radial gradient, screen-blended (desktop only). */
function f1Glow(bar, t) {
  const U = Math.sqrt((bar.W * bar.pitch) / (826 * 3.5))
  const live = bar.live
  const pulse = live ? 0.9 + 0.1 * Math.sin(t * 23 + bar.seed) * Math.sin(t * 9.7) : 0.85 + 0.15 * Math.sin(t * 2.1)
  return { x: bar.head - (live ? 12 : 4) * U, y: bar.H / 2, rx: (live ? 38 : 14) * U, ry: bar.H * (live ? 0.95 : 0.7), rgb: mix3(WHITE, bar.ink.hot, live ? 0.35 : 0.8), alpha: (live ? 0.34 : 0.14) * pulse }
}

// ---- Cell bars, per surface: an Svg of rounded squares on the desktop, a half-block Raster on the terminal.
/** Where a bar's cells sit. Desktop: `size` px wide, pitch = H / rows. Terminal: `size` columns, two half-block rows. */
function geoOf(term, size, H, rows) {
  if (term) {
    const cols = Math.max(1, Math.min(512, Math.floor(size)))
    return { term: true, cols, rows: 2, pitch: 8, H: 16, W: cols * 8 }
  }
  const W = Math.max(20, Math.floor(size)), pitch = H / rows
  return { term: false, W, H, rows, pitch, cols: Math.ceil(W / pitch) }
}
/**
 * One bar. `colorAt(cx, cy)` → [r,g,b] in 0..1, or null for the bare track. `o.ticks`: [{ frac, color, w }] drawn on
 * top; `o.glow` (desktop): an f1Glow. Returns null where the surface has neither Svg nor Raster.
 *
 * The desktop never redraws a bar to animate it (a redraw drops a press), so a desktop bar animates by itself, with
 * SMIL inside the Svg, and loops until the next drawing. Two ways:
 *   `o.anim` { n, dt, at(t) → { colorAt, glow } }: a flip-book of n frames dt apart (the fire); a cell whose colour
 *     changes gets an <animate> of its fill, a still cell is one <use>. Trimmed to fewer frames if the document would
 *     pass the Svg limit.
 *   `o.glint` { from, to, dur, sigma, peak, end }: cells drawn as runs of one colour under a mask of the cell shapes,
 *     and a soft white band (a Gaussian, `sigma` px wide, `peak` opacity) sweeps from x `from` to `to` every `dur` s,
 *     over the cells left of `end` px. `colorAt` gives the still colours.
 * Neither depends on the clock: the frames run from t = 0 and the sweep starts at its left, so the document is the same
 * string from one drawing to the next while the figures hold. That matters: a scroll of the pane is a redraw (its
 * `scroll.offset` is a prop), and an Svg whose source has not changed is left running; a changed one is loaded afresh,
 * which froze and jumped the bar on every scroll tick.
 */
function cellBar(ui, key, geo, colorAt, o = {}) {
  const track = o.track || BAR_TRACK
  if (geo.term) {
    const trackN = parseInt(track.slice(1), 16)
    const num = (c) => (c ? parseInt(toHex(c).slice(1), 16) : trackN)
    const ticks = new Map((o.ticks || []).map((m) => [Math.max(0, Math.min(geo.cols - 1, Math.floor(m.frac * geo.cols))), m.color]))
    if (typeof ui.Raster === 'function') {
      const words = new Uint32Array(geo.cols * 3)
      for (let cx = 0, i = 0; cx < geo.cols; cx++) {
        const a = colorAt(cx, 0), b = colorAt(cx, 1), tk = ticks.get(cx)
        if (tk) { words[i++] = 0x2502; words[i++] = parseInt(tk.slice(1), 16); words[i++] = num(b) }   // │ a mark
        else { words[i++] = 0x2580; words[i++] = num(a); words[i++] = num(b) }                         // ▀ top cell fg, bottom bg
      }
      return h(ui.Raster, { key, columns: geo.cols, rows: 1, cells: base64(new Uint8Array(words.buffer)) })
    }
    const parts = []
    let run = '', runKey = '', runProps = null
    for (let cx = 0; cx < geo.cols; cx++) {
      const tk = ticks.get(cx)
      const a = tk || toHex(colorAt(cx, 0) || rgb01(track)), b = toHex(colorAt(cx, 1) || rgb01(track))
      const k = `${a}${b}${tk ? '|' : ''}`
      if (k !== runKey) { if (run) parts.push(h(ui.Text, runProps, run)); run = ''; runKey = k; runProps = { color: a, backgroundColor: b } }
      run += tk ? '│' : '▀'
    }
    if (run) parts.push(h(ui.Text, runProps, run))
    return h(ui.Box, { flexDirection: 'row' }, ...parts)
  }
  if (typeof ui.Svg !== 'function') return null
  const { W, H, pitch, rows, cols } = geo
  // one cell shape, placed with <use>; the markup stays small because a desktop drawing may hold a whole loop of frames
  const half = 0.375 * pitch, size = (half * 2).toFixed(2), rx = Math.min(0.9, half * 0.35).toFixed(2)
  const sid = key.replace(/[^a-z0-9]/gi, ''), cid = `c${sid}`
  const rowY = (cy) => ((cy + 0.5) * pitch - half).toFixed(2)
  const cellX = (cx) => ((cx + 0.5) * pitch - half).toFixed(1)
  const ticks = (o.ticks || []).map((m) => `<rect x="${(m.frac * W - (m.w || 1.5) / 2).toFixed(1)}" y="0" width="${m.w || 1.5}" height="${H}" fill="${m.color}"/>`)
  const pad = o.padY || 0, HH = H + 2 * pad
  const wrap = (defs, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HH}" viewBox="0 ${-pad} ${W} ${HH}"><defs>${defs}</defs>` +
    `<rect width="${W}" height="${H}" rx="${o.radius ?? Math.min(4, H / 2)}" fill="${track}"/>${body}${ticks.join('')}</svg>`
  const glowOf = (g, alphas, an) => {
    if (!g || !alphas.some((a) => a > 0)) return { defs: '', el: '' }
    const id = `gl${sid}`, c = toHex(g.rgb), a0 = alphas[0].toFixed(3)
    const still = !an || alphas.every((a) => a.toFixed(3) === a0)
    const anim = still ? '' : `<animate attributeName="stop-opacity" values="${alphas.map((a) => a.toFixed(3)).join(';')}" dur="${(an.n * an.dt).toFixed(2)}s" calcMode="discrete" repeatCount="indefinite"/>`
    return {
      defs: `<radialGradient id="${id}"><stop offset="0" stop-color="${c}" stop-opacity="${a0}">${anim}</stop><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`,
      el: `<ellipse cx="${g.x.toFixed(1)}" cy="${g.y.toFixed(1)}" rx="${g.rx.toFixed(1)}" ry="${g.ry.toFixed(1)}" fill="url(#${id})" style="mix-blend-mode:screen"/>`,
    }
  }
  let source, animated = false
  if (o.glint) {
    // runs of one colour as rects, cut to cell shapes by a mask; the glint is one more rect, its gradient on the move
    const gl = o.glint
    const mask = [], body = []
    for (let cy = 0; cy < rows; cy++) {
      const pos = [], runs = []
      let run = null
      for (let cx = 0; cx < cols; cx++) {
        const c = colorAt(cx, cy)
        if (!c) { run = null; continue }
        pos.push(`<use href="#${cid}" x="${cellX(cx)}"/>`)
        const hex = toHex(c)
        if (run && run.hex === hex && run.to === cx - 1) run.to = cx
        else runs.push((run = { hex, from: cx, to: cx }))
      }
      if (!pos.length) continue
      mask.push(`<g transform="translate(0 ${rowY(cy)})">${pos.join('')}</g>`)
      body.push(...runs.map((r) => `<rect x="${(r.from * pitch).toFixed(1)}" y="${(cy * pitch).toFixed(2)}" width="${((r.to - r.from + 1) * pitch).toFixed(1)}" height="${pitch.toFixed(2)}" fill="${r.hex}"/>`))
    }
    let defs = `<rect id="${cid}" width="${size}" height="${size}" rx="${rx}"/><mask id="m${sid}"><g fill="#fff">${mask.join('')}</g></mask>`
    let glint = ''
    if (gl.end > 0 && body.length) {
      animated = true
      const span = 3 * gl.sigma
      const stops = Array.from({ length: 13 }, (_, i) => {
        const d = (i / 12 - 0.5) * 2 * span / gl.sigma
        return `<stop offset="${(i / 12).toFixed(3)}" stop-color="#fff" stop-opacity="${(gl.peak * Math.exp(-d * d)).toFixed(3)}"/>`
      })
      // the band is a rect carrying its gradient (user space moves with it), slid by a transform; a clip keeps it left of `end`
      defs += `<linearGradient id="g${sid}" gradientUnits="userSpaceOnUse" x1="${-span}" y1="0" x2="${span}" y2="0">${stops.join('')}</linearGradient>` +
        `<clipPath id="k${sid}"><rect x="0" y="0" width="${gl.end.toFixed(1)}" height="${H}"/></clipPath>`
      glint = `<g clip-path="url(#k${sid})"><rect x="${-span}" y="0" width="${2 * span}" height="${H}" fill="url(#g${sid})">` +
        `<animateTransform attributeName="transform" type="translate" from="${gl.from.toFixed(1)} 0" to="${gl.to.toFixed(1)} 0" dur="${gl.dur}s" repeatCount="indefinite"/></rect></g>`
    }
    source = wrap(defs, `<g mask="url(#m${sid})">${body.join('')}${glint}</g>`)
  } else {
    const an = o.anim && o.anim.n > 1 ? { ...o.anim } : null
    const build = () => {
      let frames
      if (an) frames = Array.from({ length: an.n }, (_, k) => an.at(k * an.dt))
      else frames = [{ colorAt, glow: o.glow }]
      const dur = an ? `${(an.n * an.dt).toFixed(2)}s` : ''
      const cells = []
      for (let cy = 0; cy < rows; cy++) {
        const run = []
        for (let cx = 0; cx < cols; cx++) {
          const hs = frames.map((f) => { const c = f.colorAt(cx, cy); return c ? toHex(c) : null })
          if (!hs.some(Boolean)) continue
          const vals = hs.map((x) => x || track)
          if (vals.every((x) => x === vals[0])) run.push(`<use href="#${cid}" x="${cellX(cx)}" fill="${vals[0]}"/>`)
          else {
            animated = true
            run.push(`<use href="#${cid}" x="${cellX(cx)}" fill="${vals[0]}"><animate attributeName="fill" values="${vals.join(';')}" dur="${dur}" calcMode="discrete" repeatCount="indefinite"/></use>`)
          }
        }
        if (run.length) cells.push(`<g transform="translate(0 ${rowY(cy)})">${run.join('')}</g>`)
      }
      const g0 = frames[0].glow
      const glow = glowOf(g0, frames.map((f) => (f.glow ? f.glow.alpha : 0)), an)
      return wrap(`<rect id="${cid}" width="${size}" height="${size}" rx="${rx}"/>${glow.defs}`, `${cells.join('')}${glow.el}`)
    }
    source = build()
    // the Svg limit is 131072 chars: a wide bar with a long loop drops to fewer, longer-held frames
    while (an && source.length > 120000 && an.n > 3) { an.n = Math.ceil(an.n / 2); an.dt *= 2; animated = false; source = build() }
  }
  return h(ui.Svg, { source, alt: o.alt || key, height: HH, width: W, ...(animated ? { isInteractive: true } : {}) })
}

/** The context bar: F1 in the threshold colour, ticks at the marks still ahead, the auto-compact buffer drawn still. */
function contextBar(ui, geo, view, t, live, padY = 0) {
  const track = geo.term ? BAR_TRACK : DESK_TRACK
  const info = fireBar(geo, view.pct / 100, live, 31, inkOf(ui.hex(view.accent)), track)
  const autoX = view.compactPct === null ? Infinity : (view.compactPct / 100) * geo.W
  const buf = rgb01(geo.term ? BUFFER_CELL : DESK_BUFFER)
  const at = (tt) => {
    const st = f1Frame(info, tt)
    const colorAt = (cx, cy) => {
      const px = (cx + 0.5) * geo.pitch
      if (px >= autoX && px > info.head + 3 * geo.pitch) return buf
      return f1Shade(cx, cy, info, st)
    }
    return { colorAt, glow: geo.term ? null : f1Glow(info, tt) }
  }
  const now = at(t)
  const ticks = view.marksAll.filter((m) => m.pct > view.pct && m.pct < 100).map((m) => ({ frac: m.pct / 100, color: MARK_TICK, w: 1.5 }))
  if (view.compactPct !== null) ticks.push({ frac: view.compactPct / 100, color: AUTO_TICK, w: 1 })
  return cellBar(ui, 'ctx-bar', geo, now.colorAt, { track, ticks, padY, glow: now.glow, anim: geo.term ? null : { n: LOOP_N, dt: LOOP_DT, at }, alt: `Context ${view.pct}%` })
}

/** A card's bar: F1 live ('fire') or calm ('ember'); a dim run to where it is heading; a tick (the time in a window). */
function cardBar(ui, key, geo, bar, t, style) {
  const grad = bar.ink === 'grad'
  const inkHex = grad ? CACHE_GRAD[2] : ui.hex(bar.ink || 'inactive')
  const ink = grad ? { hot: mix3(rgb01(CACHE_GRAD[2]), WHITE, 0.45), c0: rgb01(CACHE_GRAD[2]), c1: rgb01(CACHE_GRAD[0]) } : inkOf(inkHex)
  const lit = bar.fill > 0
  const info = fireBar(geo, bar.fill, style === 'fire', seedOf(key), ink, CACHE_TRACK)
  const dim = bar.ext > bar.fill ? rgb01(mixHex(inkHex, CACHE_TRACK, 0.55)) : null
  const at = (tt) => {
    const st = lit ? f1Frame(info, tt) : null
    const colorAt = (cx, cy) => {
      const c = lit ? f1Shade(cx, cy, info, st) : null
      if (c) return c
      const f = (cx + 0.5) / geo.cols
      return dim && f > bar.fill + 1 / geo.cols && f <= bar.ext ? dim : null
    }
    return { colorAt, glow: geo.term || !lit ? null : f1Glow(info, tt) }
  }
  const now = at(t), colorAt = now.colorAt
  const ticks = bar.tick === null || bar.tick === undefined ? [] : [{ frac: bar.tick, color: ui.hex('text'), w: 2 }]
  return cellBar(ui, key, geo, colorAt, { track: CACHE_TRACK, ticks, glow: now.glow, anim: geo.term || !lit ? null : { n: LOOP_N, dt: LOOP_DT, at }, radius: 3, padY: geo.term ? 0 : INNER_PAD, alt: key })
}

/** The Saved bar: three greens, one per source; a soft white glint sweeps across the fill every 3.2 s. */
function savedBar(ui, geo, parts, share, t) {
  const fillW = share * geo.W
  let acc = 0
  const segs = parts.map((p) => ({ end: (acc += p.f) * geo.W, rgb: rgb01(p.color) }))
  const sweep = ((t % 3.2) / 3.2) * (fillW + 120) - 60
  const base = (cx) => {
    const px = (cx + 0.5) * geo.pitch
    return px > fillW || !segs.length ? null : (segs.find((s) => px <= s.end) || segs[segs.length - 1]).rgb
  }
  const colorAt = geo.term ? (cx, cy) => {
    const b = base(cx)
    if (!b) return null
    const dx = ((cx + 0.5) * geo.pitch - sweep + cy * 3) / 22
    const k = 0.55 * Math.exp(-dx * dx)
    return k > 0.01 ? mix3(b, WHITE, k) : b
  } : base
  const glint = geo.term ? null : { from: -60, to: fillW + 60, dur: 3.2, sigma: 22, peak: 0.55, end: fillW }
  return cellBar(ui, 'saved-bar', geo, colorAt, { track: CACHE_TRACK, radius: 3, padY: geo.term ? 0 : INNER_PAD, glint, alt: `Saved, ${Math.round(share * 100)}% of input` })
}

/** Working memory: a cell per slice of the window by kind; a light wave runs through the used part every 2.8 s. */
function memoryBar(ui, geo, parts, t) {
  let acc = 0, usedEnd = 0, open = true
  const segs = parts.map((p) => {
    acc += p.f
    if (open && p.color) usedEnd = acc
    else open = false
    return { end: acc, rgb: p.color ? rgb01(p.color) : null }
  })
  const wave = ((t % 2.8) / 2.8) * (usedEnd * geo.W + 160) - 60
  const base = (cx) => {
    const s = segs.find((x) => (cx + 0.5) / geo.cols < x.end)
    return s && s.rgb ? s.rgb : null
  }
  const colorAt = geo.term ? (cx, cy) => {
    const b = base(cx)
    if (!b || (cx + 0.5) / geo.cols > usedEnd) return b
    const dx = ((cx + 0.5) * geo.pitch - wave) / 26
    const k = 0.42 * Math.exp(-dx * dx)
    return k > 0.01 ? mix3(b, WHITE, k) : b
  } : base
  const glint = geo.term ? null : { from: -60, to: usedEnd * geo.W + 100, dur: 2.8, sigma: 26, peak: 0.42, end: usedEnd * geo.W }
  return cellBar(ui, 'mem-bar', geo, colorAt, { padY: geo.term ? 0 : INNER_PAD, glint, alt: "Claude's working memory by kind" })
}

/** Five tiny cells for the closed pane: lit count is the warmth along the cache gradient; cold is all frozen blue. */
function cacheMini(ui, cache) {
  const FROZEN = mixHex(COLD, CACHE_TRACK, 0.45)
  const lit = cache.warm ? Math.max(1, Math.ceil(cache.fill * 5)) : 0
  const colors = Array.from({ length: 5 }, (_, i) => (cache.warm ? (i < lit ? gradAt((i + 0.5) / 5) : CACHE_TRACK) : cache.known ? FROZEN : CACHE_TRACK))
  if (ui.term || typeof ui.Svg !== 'function') return colors.map((c, i) => h(ui.Text, { key: `mini${i}`, color: c }, '▪'))
  const rects = colors.map((c, i) => `<rect x="${i * 7}" y="2.5" width="5" height="5" rx="1" fill="${c}"/>`).join('')
  return [h(ui.Svg, { source: `<svg xmlns="http://www.w3.org/2000/svg" width="33" height="10" viewBox="0 0 33 10">${rects}</svg>`, alt: `Cache ${cache.accent}`, width: 33, height: 10 })]
}

/** Fold one breakdown row to a working-memory kind (colour and order). */
function memKey(c) {
  if (c.kind === 'free') return 'free'
  if (c.kind === 'buffer') return 'buffer'
  const n = String(c.name || '').toLowerCase()
  if (/mcp/.test(n)) return 'mcp'
  if (/skill/.test(n)) return 'skills'
  if (/system prompt/.test(n)) return 'system'
  if (/system tool|^tools?$/.test(n)) return 'tools'
  if (/memory/.test(n)) return 'memory'
  if (/agent/.test(n)) return 'agents'
  if (/message/.test(n)) return 'messages'
  return 'other'
}

const AGENT_SOURCE = { projectSettings: 'Project', userSettings: 'User', localSettings: 'Local', policySettings: 'Managed', plugin: 'Plugin', flagSettings: 'Flag' }
const SKILL_SOURCE = { 'built-in': 'Built-in', bundled: 'Built-in', userSettings: 'User', projectSettings: 'Project', localSettings: 'Local', mcp: 'MCP', syncedSkills: 'Synced', plugin: 'Plugin' }

/** Biggest first, at most six, the rest folded into one "N more" row. */
function topItems(items, more = 'more') {
  const sorted = [...items].sort((a, b) => b.tokens - a.tokens)
  if (sorted.length <= 6) return sorted
  const rest = sorted.slice(6)
  return [...sorted.slice(0, 6), { name: `${rest.length} ${more}`, detail: '', tokens: rest.reduce((n, x) => n + x.tokens, 0) }]
}
function basename(p) {
  return String(p || '').split(/[\\/]/).pop()
}

/** The drill-down groups, like the › rows in Claude's /context: what is inside each kind, and the command that trims it. */
function drillGroups(b, home) {
  const out = []
  if (!b) return out
  const mcp = Array.isArray(b.mcpTools) ? b.mcpTools : []
  if (mcp.length) {
    const servers = new Map()
    for (const tl of mcp) {
      const s = servers.get(tl.serverName) || { name: String(tl.serverName || 'mcp'), loaded: 0, deferred: 0, tools: 0, loadedTools: 0 }
      s.tools += 1
      if (tl.isLoaded === false) s.deferred += Number(tl.tokens) || 0
      else { s.loaded += Number(tl.tokens) || 0; s.loadedTools += 1 }
      servers.set(tl.serverName, s)
    }
    const live = [...servers.values()].filter((s) => s.loadedTools > 0)
    const asleep = [...servers.values()].filter((s) => s.loadedTools === 0)
    const items = topItems(live.map((s) => ({ name: s.name, detail: `${s.tools} tool${s.tools === 1 ? '' : 's'}`, tokens: s.loaded })), 'more servers')
    if (asleep.length) {
      const tools = asleep.reduce((n, s) => n + s.tools, 0)
      items.push({ name: `${asleep.length} deferred server${asleep.length === 1 ? '' : 's'}`, detail: `${tools} tool${tools === 1 ? '' : 's'} · Deferred`, tokens: asleep.reduce((n, s) => n + s.deferred, 0) })
    }
    const loaded = live.reduce((n, s) => n + s.loaded, 0)
    out.push({ id: 'mcp', label: 'MCP tools', tokens: loaded, count: mcp.length, items, cmd: 'mcp', what: "Turn off servers you don't use", save: loaded ? `Up to −${fmtK(loaded)}` : '' })
  }
  const mem = Array.isArray(b.memoryFiles) ? b.memoryFiles : []
  if (mem.length) {
    const seen = new Set()
    let dupTok = 0, dupName = ''
    const items = mem.map((f) => {
      const id = `${basename(f.path)}:${f.tokens}`
      const twice = seen.has(id)
      seen.add(id)
      if (twice) { dupTok += Number(f.tokens) || 0; dupName = dupName || basename(f.path) }
      const path = home && String(f.path).startsWith(home + '/') ? '~' + String(f.path).slice(home.length) : String(f.path)
      return { name: path, detail: twice ? `${f.type || 'File'} · Loaded twice` : String(f.type || ''), tokens: Number(f.tokens) || 0, warn: twice }
    })
    out.push({ id: 'memory', label: 'Memory files', tokens: items.reduce((n, x) => n + x.tokens, 0), count: mem.length, items: topItems(items),
      cmd: 'memory', what: dupTok ? `Drop the duplicate ${dupName}` : "Trim what Claude doesn't need", save: dupTok ? `−${fmtK(dupTok)}` : '' })
  }
  const agents = Array.isArray(b.agents) ? b.agents : []
  if (agents.length) {
    const items = agents.map((a) => ({ name: String(a.agentType), detail: AGENT_SOURCE[a.source] || String(a.source || ''), tokens: Number(a.tokens) || 0 }))
    const tok = items.reduce((n, x) => n + x.tokens, 0)
    out.push({ id: 'agents', label: 'Custom agents', tokens: tok, count: agents.length, items: topItems(items), cmd: 'agents', what: 'Remove agents you never spawn', save: tok ? `Up to −${fmtK(tok)}` : '' })
  }
  const sk = b.skills && Array.isArray(b.skills.skillFrontmatter) ? b.skills : null
  if (sk && sk.skillFrontmatter.length) {
    const items = sk.skillFrontmatter.map((s) => ({ name: String(s.name), detail: s.source === 'plugin' && s.pluginName ? String(s.pluginName) : SKILL_SOURCE[s.source] || String(s.source || ''), tokens: Number(s.tokens) || 0, builtin: s.source === 'built-in' || s.source === 'bundled' }))
    const parkable = items.filter((x) => !x.builtin).reduce((n, x) => n + x.tokens, 0)
    out.push({ id: 'skills', label: 'Skills', tokens: Number(sk.tokens) || items.reduce((n, x) => n + x.tokens, 0), count: Number(sk.totalSkills) || items.length,
      items: topItems(items), cmd: 'loadout', what: 'Park skills you never call', save: parkable ? `Up to −${fmtK(parkable)}` : '' })
  } else if (skillsData && !skillsData.error && Array.isArray(skillsData.active) && skillsData.active.length) {
    // no skill listing in the breakdown: the loadout scan's own figures
    const items = skillsData.active.map((s) => ({ name: String(s.name), detail: (skillsData.unused || []).includes(s.name) ? 'Unused 30+ days' : '', tokens: Number(s.per_turn) || 0 }))
    const unused = items.filter((x) => x.detail).reduce((n, x) => n + x.tokens, 0)
    out.push({ id: 'skills', label: 'Skills', tokens: Number(skillsData.per_turn_tokens) || items.reduce((n, x) => n + x.tokens, 0), count: items.length,
      items: topItems(items), cmd: 'loadout', what: 'Park skills you never call', save: unused ? `Up to −${fmtK(unused)}` : '' })
  }
  return out
}

/** The pane's view model: context fill and breakdown, our thresholds, cache warmth, and what the pack saved. */
function contextView(usage, ttl, usageLast, clock, stats) {
  const ctx = (usage && usage.context) || {}
  const b = ctx.breakdown || null
  const window = Number(ctx.window) || (b && Number(b.rawMaxTokens)) || 0
  const used = b && Number.isFinite(b.totalTokens) ? b.totalTokens : Number.isFinite(ctx.tokens) ? ctx.tokens : sentOf(usageLast)
  const measure = (b && Number(b.rawMaxTokens)) || window || Math.max(used, 1)
  const pct = b && Number.isFinite(b.percentage) ? pct100(b.percentage) : Number.isFinite(ctx.percent) ? pct100(ctx.percent) : pct100((100 * used) / measure)
  const compactOn = !!(b && b.isAutoCompactEnabled && Number.isFinite(b.autoCompactThreshold) && b.autoCompactThreshold > 0)
  const compactPct = compactOn ? pct100((100 * b.autoCompactThreshold) / measure) : null
  // A 1M window with auto-compact near the top: the compaction itself re-reads close to a million tokens
  const compactHint1M = compactOn && measure >= 1_000_000 && b.autoCompactThreshold > 900_000
    ? `Auto-compact at ${fmtK(b.autoCompactThreshold)} on a 1M window: run /autocompact 400k so a compaction never re-reads near a million tokens` : ''
  const marksAll = levels.map((l) => ({ pct: Number(l.pct), id: String(l.id || ''), hint: l.hint })).filter((m) => Number.isFinite(m.pct)).sort((x, y) => x.pct - y.pct)
  const crossed = Math.min(3, marksAll.filter((m) => m.pct <= pct).length)
  const nextMark = marksAll.find((m) => m.pct > pct) || null
  const prevMark = [...marksAll].reverse().find((m) => m.pct <= pct) || null
  const handoffPct = (marksAll.find((m) => m.hint === 'new-conversation') || { pct: 60 }).pct
  const compactMarkPct = (marksAll.find((m) => m.hint === 'compact-if-warm') || { pct: 75 }).pct

  // the cache: what it means for the next message
  const ttlMin = Math.max(1, Math.round(ttl / MINUTE))
  const amount = fmtK(used || sentOf(usageLast))
  const hit = hitPct(usageLast)
  let cache
  if (!clock || !clock.known) {
    cache = { known: false, warm: false, cooling: false, leftMin: 0, fill: 0, accent: 'Cold', strong: 'No response yet', rest: '', foot: 'The clock starts after the first reply', short: 'Cache after 1st reply',
      sentence: [['No response yet: the cache clock starts after the first reply', 'inactive']] }
  } else if (clock.warm) {
    const leftMin = Math.max(1, Math.round(clock.leftMs / MINUTE))
    // "cooling" in the last five minutes, or the last third of a short TTL (a 5-minute TTL would otherwise always cool)
    const cooling = clock.leftMs <= Math.min(5 * MINUTE, ttl / 3)
    cache = { known: true, warm: true, cooling, leftMin, fill: clock.leftMs / ttl, accent: 'Warm', strong: `Warmth ${pct100((100 * clock.leftMs) / ttl)}%`, rest: ` · Hit ${hit}%`,
      foot: `${leftMin}m left of ${ttlMin}m`, short: `Warm ${leftMin}m`,
      sentence: cooling
        ? [['Cache cooling: ', 'inactive'], [`${leftMin}m left to reuse `, 'inactive'], [amount, 'text'], [' from cache', 'inactive']]
        : [['Cache warm: next message reuses ', 'inactive'], [amount, 'text'], [' from cache', 'inactive'], [` · ${leftMin}m left`, 'inactive']] }
  } else {
    cache = { known: true, warm: false, cooling: false, leftMin: 0, fill: 0, accent: 'Cold', strong: 'Warmth 0%', rest: ` · Hit ${hit}%`,
      foot: `Idle ${Math.max(1, Math.round(clock.idleMs / MINUTE))}m, past ${ttlMin}m`, short: 'Cold',
      sentence: [['Cache cold: next message re-caches ', 'inactive'], [amount, 'text']] }
  }
  cache.amount = amount

  // what the pack saved, in the currency you pay in
  const saved = stats || {}
  const T = saved.totals || { turns: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, keptOut: 0, vetoTokens: 0, switchHeld: 0, switchPaid: 0, oneShot: 0 }
  const limits = (usage && usage.rateLimits) || []
  const five = limits.find((r) => r.kind === 'five_hour') || null
  const hasCost = !!(usage && usage.cost && Number.isFinite(usage.cost.usd))
  const mode = hasCost ? 'api' : five ? 'subscription' : 'unknown'
  const inputAll = T.input + T.cacheRead + T.cacheWrite
  // spend in fresh-input-token equivalents: input 1×, cache write 1.25×, cache read 0.1×, output 5× (the pricing ratios)
  const billedUnits = T.input + 1.25 * T.cacheWrite + 0.1 * T.cacheRead + 5 * T.output
  const rate = Number(saved.rate) || (hasCost && billedUnits > 50_000 ? (usage.cost.usd / billedUnits) * 1e6 : 0)
  const kw = saved.keepWarm || { pings: 0, savedTok: 0, costTok: 0 }
  const warmNet = kw.savedTok - kw.costTok                 // can be negative: pings you never came back for
  // Only what the plugin itself did. Claude's own prompt cache is reported beside it, never added in: it would
  // read the same with or without the plugin, and claiming it made the headline a lie.
  const sources = [
    { label: 'Trimmed output', tok: T.keptOut },                                   // ≈ chars ÷ 4, never re-sent
    { label: 'Compactions vetoed', tok: Math.round(T.vetoTokens * 1.25) },         // the 1.25× re-write a cold /compact would have paid
    { label: 'Keep-warm', tok: warmNet },                                          // re-writes avoided, less what the pings cost
    { label: 'Model switches held', tok: Math.round((T.switchHeld || 0) * 1.25) }, // the cold re-write on the other model that a 'Stay' avoided
  ]
  const totalTok = Math.max(0, sources[0].tok + sources[1].tok + warmNet + sources[3].tok)
  const cacheInfo = { read: T.cacheRead, line: T.cacheRead > 0 ? `Prompt cache read ${fmtK(T.cacheRead)} tokens at a tenth of the price — Claude's own, not counted` : '' }
  const share = totalTok > 0 ? totalTok / (totalTok + billedUnits) : 0
  const priced = mode === 'api' && rate > 0
  const usd = (tok) => (priced ? `$${((tok * rate) / 1e6).toFixed(2)}` : '')
  const base = saved.limitBase
  const tokPerPct = base && five && five.percentUsed - base.pct >= 1 ? (inputAll - base.tokens) / (five.percentUsed - base.pct) : 0
  const spent = hasCost ? usage.cost.usd : 0
  const right = mode === 'api'
    ? [...(priced ? [[`≈ ${usd(totalTok)}`, 'success'], [` · Spent $${spent.toFixed(2)}`, 'inactive']] : [[`Spent $${spent.toFixed(2)}`, 'inactive']])]
    : mode === 'subscription' && tokPerPct > 0 && totalTok > 0 ? [[`≈ ${Math.max(1, Math.round(totalTok / tokPerPct))}% of the 5-hour window`, 'success']] : []
  const month = saved.month || null
  const monthName = month && /^saved:\d{4}-\d{2}$/.test(month.key) ? MONTHS[Number(month.key.slice(-2)) - 1] : ''
  const receipt = [
    ...sources.map((s) => ({ label: s.label, tok: fmtK(s.tok), amount: priced ? `≈ ${usd(s.tok)}` : '', role: 'inactive', amountRole: s.tok < 0 ? 'warning' : 'success' })),
    ...(T.cacheRead > 0 ? [{ label: "Prompt cache, Claude's own (not counted)", tok: fmtK(T.cacheRead), amount: '', role: 'inactive', amountRole: 'inactive' }] : []),
    ...(T.switchPaid > 0 ? [{ label: 'Model switches, cold re-read (not a saving)', tok: fmtK(Math.round(T.switchPaid * 1.25)), amount: priced ? `≈ ${usd(Math.round(T.switchPaid * 1.25))}` : '', role: 'inactive', amountRole: 'inactive' }] : []),
    ...(T.agentLapses > 0 ? [{ label: 'Agents re-read after a long wait (not a saving)', tok: fmtK(T.agentLapseTok), amount: priced ? `≈ ${usd(T.agentLapseTok)}` : '', role: 'inactive', amountRole: 'inactive' }] : []),
    { rule: true },
    { label: 'Total saved', tok: fmtK(totalTok), amount: priced ? `≈ ${usd(totalTok)}` : '', role: 'text', amountRole: 'success' },
    ...(priced ? [
      { label: 'You paid', tok: '', amount: `$${spent.toFixed(2)}`, role: 'inactive', amountRole: 'text' },
      { label: 'Without token-saver', tok: '', amount: `≈ $${(spent + (totalTok * rate) / 1e6).toFixed(2)}`, role: 'inactive', amountRole: 'inactive' },
    ] : month && monthName && month.tok > totalTok ? [{ label: `${monthName}, across sessions`, tok: fmtK(month.tok), amount: '', role: 'inactive', amountRole: 'inactive' }] : []),
  ]
  const note = mode === 'api' ? (Number(saved.rate) ? `At $${Number(saved.rate).toFixed(2)}/M input (your rate)` : rate ? `At ≈$${rate.toFixed(2)}/M input, derived from this session's bill` : 'Set $/M in /config for dollars')
    : mode === 'subscription' ? (tokPerPct > 0 ? 'Subscription: savings shown as window headroom' : 'Subscription: window maths appears once the 5-hour window moves') : 'Tokens only'
  const oneShotNote = T.oneShot > 0 ? ` · ${T.oneShot} one-off message${T.oneShot === 1 ? '' : 's'} on another model, each paid as one cold read` : ''
  // What a model switch costs right now: the whole context re-cached on the other model at 1.25× the input price,
  // priced at this session's own rate (the switch dialog itself has the engine's list-price estimate for the target)
  const switchUnits = Math.round(used * 1.25)
  const switchUsd = priced ? usd(switchUnits) : ''
  const switchPct = !priced && tokPerPct > 0 ? `${Math.max(1, Math.round(switchUnits / tokPerPct))}% of the 5-hour window` : ''
  const switchCost = !cache.known || !cache.warm
    ? { verdict: 'free', short: 'Switch model: free', line: 'Switching model now is free: the cache is cold, so the next message re-reads everything either way.' }
    : used < SWITCH_CHEAP
      ? { verdict: 'cheap', short: 'Switch model: cheap', line: `Switching model now is cheap: ${fmtK(used)} tokens re-read once.` }
      : { verdict: 'costly', short: `Switch model ≈ ${switchUsd || switchPct || `${fmtK(switchUnits)} tokens`}`,
          line: `Switching model now re-caches ${fmtK(used)} tokens at 1.25× the input price${switchUsd ? `, ≈ ${switchUsd} at this session's rate` : switchPct ? `, ≈ ${switchPct}` : ''}.` }
  // Subagent cache lapses: the worst agent type by what a 1-hour cache would have saved, net of its 2× write price.
  // Measured (the receipt row above) whatever the billing; recommended only where the engine would honour it.
  const types = (saved.agents && saved.agents.types) || new Map()
  const weeks = (saved.agents && saved.agents.weeks) || {}
  let worst = null
  for (const [type, a] of types) {
    if (!a.lapses) continue
    const net = Math.round(LAPSE_RE * a.lapseWrite - LONG_PREMIUM * a.otherWrite)
    if (!worst || net > worst.net) worst = { type, net, lapses: a.lapses, reread: a.lapseWrite }
  }
  // Plain words: an agent "waited over 5 minutes and re-read" what it had. No cache jargon in the pane.
  let agentLine = ''
  if (worst && !onCredits(usage)) {
    const week = Number(weeks[worst.type]) || 0
    const times = `${worst.lapses}× this session${week > worst.lapses ? ` (${week} this week)` : ''}`
    const what = `The ${worst.type} agent waited over 5 minutes ${times} and re-read ${fmtK(worst.reread)} tokens.`
    agentLine = worst.net > 0
      ? `${what} A 1-hour cache for it would have saved ≈ ${fmtK(worst.net)} tokens: put cacheTtl: 1h under experimental in its agent file.`
      : `${what} A 1-hour cache would cost more than it saves here; shorten its waits instead.`
  }
  const savings = { mode, rate, priced, totalTok, share, sources, cacheInfo, right, receipt, note: note + oneShotNote, short: totalTok ? `${fmtK(totalTok)} saved` : '0 saved', spent, hasCost, agentLine, agentLapses: T.agentLapses, agentLapseTok: T.agentLapseTok }

  // Claude's working memory, by kind, as /context lists it
  let rows
  if (b && Array.isArray(b.categories) && b.categories.length) {
    const all = b.categories.map((c, i) => ({ c, i, key: memKey(c), deferred: c.kind === 'deferred' || c.isDeferred === true }))
    const usedRows = all.filter((x) => !x.deferred && x.c.kind !== 'free' && x.c.kind !== 'buffer' && (Number(x.c.tokens) || 0) > 0)
      .sort((x, y) => MEM_RANK.indexOf(x.key) - MEM_RANK.indexOf(y.key) || x.i - y.i)
    const tail = [...all.filter((x) => !x.deferred && x.c.kind === 'buffer'), ...all.filter((x) => !x.deferred && x.c.kind === 'free')]
    const deferred = all.filter((x) => x.deferred && (Number(x.c.tokens) || 0) > 0)
    rows = [...usedRows, ...tail, ...deferred].map((x) => ({
      key: x.key, name: x.deferred && !/deferred/i.test(x.c.name) ? `${x.c.name} (deferred)` : String(x.c.name), tokens: Number(x.c.tokens) || 0,
      deferred: x.deferred, color: x.deferred ? MEM.buffer : MEM[x.key] || MEM.other,
    }))
  } else {
    rows = [{ key: 'messages', name: 'Used', tokens: used, deferred: false, color: MEM.messages }, ...(window ? [{ key: 'free', name: 'Free space', tokens: Math.max(0, window - used), deferred: false, color: MEM.free }] : [])]
  }
  for (const r of rows) r.pct = r.deferred ? '—' : `${((100 * r.tokens) / measure).toFixed(1)}%`
  const live = rows.filter((r) => !r.deferred)
  const parts = [...live.filter((r) => r.key !== 'free' && r.key !== 'buffer'), ...live.filter((r) => r.key === 'free'), ...live.filter((r) => r.key === 'buffer')]
    .map((r) => ({ f: Math.max(0, r.tokens / measure), color: r.key === 'free' ? null : r.color }))

  return {
    hasData: !!usage, pct, used, window, measure, crossed, accent: ACC[crossed], marksAll, nextMark, prevMark, compactPct, compactHint1M, handoffPct, compactMarkPct,
    title: { used: window ? `${fmtK(used)} / ${fmtK(window)} (${pct}%)` : `${fmtK(used)} tokens` },
    cache, savings, switchCost, five, memory: { rows, parts, title: window ? `${fmtK(used)} of ${fmtK(window)} tokens` : `${fmtK(used)} tokens` }, breakdown: b,
  }
}

/** Which of Clear / Compact / Later is recommended now, and which are unavailable (drawn dim, never hidden). */
function paneActions(view) {
  const fresh = !view.cache.known, cold = view.cache.known && !view.cache.warm
  const prim = fresh ? 'later' : cold && view.pct >= view.handoffPct ? 'clear' : view.pct >= view.compactMarkPct ? 'compact' : view.pct >= view.handoffPct ? 'clear' : 'later'
  const off = (k) => (fresh && k !== 'later') || (k === 'compact' && (cold || fresh))
  return { prim: off(prim) ? 'later' : prim, off }
}

/** The next-mark card: runway from the last mark crossed to the next, and messages to go at the recent growth. */
function nextCard(view, avg) {
  const cold = view.cache.known && !view.cache.warm
  const next = view.nextMark, prev = view.prevMark
  const then = (m) => ({ note: 'note decisions', 'new-conversation': 'handoff + Clear', 'compact-if-warm': 'Compact while warm' }[m.hint] || m.id)
  if (next && !(next.hint === 'compact-if-warm' && cold)) {
    const lo = prev ? prev.pct : 0
    const frac = clamp01((view.pct - lo) / Math.max(1, next.pct - lo))
    const left = Math.max(0, Math.round((view.measure * next.pct) / 100 - view.used))
    const msgs = avg > 0 ? Math.max(1, Math.ceil(left / avg)) : 0
    const span = Math.max(1, (view.measure * (next.pct - lo)) / 100)
    return { title: cap1(next.id), accent: msgs ? `In ≈${msgs} message${msgs === 1 ? '' : 's'}` : `At ${next.pct}%`, tone: ACC[crossedAt(next.pct)],
      bar: { fill: frac, ext: avg > 0 ? Math.min(1, frac + avg / span) : 0, ink: view.accent }, strong: `Runway ${Math.round(frac * 100)}%`, rest: ` · ${fmtK(left)} to go`, foot: `Then ${then(next)}` }
  }
  if (!cold) {
    return { title: 'Compact', accent: 'Now', tone: 'error', bar: { fill: 1, ink: 'error' }, strong: `Past ${view.compactMarkPct}%`, rest: view.cache.known ? ' · Cache warm' : '',
      foot: view.cache.known ? `Cheap while warm: ${view.cache.leftMin}m left` : 'Cheap while the cache is warm' }
  }
  return { title: 'Clear', accent: 'Now', tone: 'error', bar: { fill: 1, ink: 'error' }, strong: `Past ${prev ? prev.pct : view.pct}%`, rest: ' · Cache cold', foot: `Compact would re-cache ${view.cache.amount}` }
}

/** The billing card: keep-warm on the API (or where billing is unknown), the five-hour window on a subscription. */
function billCard(view, now, ttl, keepWarmMax, longTtl) {
  const f = view.five
  if (view.savings.mode === 'subscription' && f) {
    const usage = pct100(f.percentUsed)
    // The window's start is not exposed; resetsAt is, and the window is five hours long, so start = resetsAt − 5 h.
    // Without resetsAt the time tick and the reset line are left out.
    const r = f.resetsAt ? Date.parse(f.resetsAt) : NaN
    const span = 5 * 3600 * 1000
    const time = Number.isFinite(r) ? pct100((100 * (now - (r - span))) / span) : null
    const ms = Number.isFinite(r) ? Math.max(0, r - now) : 0
    return { title: 'Current session', accent: '', tone: 'success', bar: { fill: usage / 100, ext: time === null ? 0 : time / 100, tick: time === null ? null : time / 100, ink: 'success' },
      strong: `Usage ${usage}%`, rest: time === null ? '' : ` · Time ${time}%`, foot: Number.isFinite(r) ? `Resets in ${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / MINUTE)}m` : 'Five-hour window' }
  }
  if (keepWarm.on && keepWarmMax > 0) {
    const missed = !Number.isFinite(keepWarm.streak)
    const usedPings = missed ? keepWarmMax : Math.min(keepWarm.streak, keepWarmMax)
    const every = Math.max(1, Math.round((ttl - KEEP_WARM_LEAD) / MINUTE))
    return { title: 'Keep-warm', accent: 'On', tone: WARM, bar: { fill: usedPings / keepWarmMax, ink: WARM }, strong: `Pings ${usedPings} of ${keepWarmMax}`, rest: ' · 0.1× each',
      foot: missed ? 'Stopped: the cache had already gone' : `Warm ${(keepWarmMax - usedPings) * every}m more if away` }
  }
  const why = keepWarm.stopped ? cap1(keepWarm.stopped) : longTtl ? 'One-hour cache' : 'Turned off'
  return { title: 'Keep-warm', accent: 'Off', tone: 'inactive', bar: { fill: 0 }, strong: why, rest: '',
    foot: keepWarm.stopped === 'not API billing' ? 'A subscription caches for an hour already' : longTtl ? 'A lapse is rare with the one-hour cache' : 'Turn it on in /config' }
}

function cacheCard(view) {
  const c = view.cache
  return { title: 'Cache', accent: c.accent, tone: c.warm ? WARM : c.known ? COLD : 'inactive', bar: { fill: c.fill, ink: 'grad' }, strong: c.strong, rest: c.rest, foot: c.foot,
    foot2: c.known && view.switchCost ? view.switchCost.short : undefined }
}

/** A long name cut to `n` cells: paths keep their tail, names their head. */
function clip(s, n) {
  s = String(s)
  if (s.length <= n) return s
  return /[\\/]/.test(s) ? '…' + s.slice(-(n - 1)) : s.slice(0, n - 1) + '…'
}

/**
 * Draw the pane from its view model. No bold anywhere; colour carries the hierarchy: figures in 'text', labels in
 * 'inactive', savings in 'success'; the title is the other way round, as the app's Context window card (name in 'text',
 * figures grey), and only the bar carries the threshold colour. `o.t` is the animation clock (s).
 */
function drawContextPane(ui, view, o) {
  const { Box, Text, Button, term } = ui
  const kids = (a) => a.filter(Boolean)
  const row = (props, children) => h(Box, { flexDirection: 'row', ...props }, ...kids(children))
  const col = (props, children) => h(Box, { flexDirection: 'column', ...props }, ...kids(children))
  // Desktop: theme names come out as one light grey there, so pass the app's own colour values; and plain spaces
  // collapse between pieces, so use no-break spaces. The terminal keeps theme names (it resolves them per theme).
  const t = (s, color, extra) => h(Text, color ? { color:term ? color : ui.hex(color), ...extra } : extra || null, term ? s : nbsp(s))
  const grow = () => h(Box, { flexGrow: 1 })
  const num = (s, color, w) => h(Box, { width: w, flexShrink: 0, justifyContent: 'flex-end' }, t(s, color))
  const fit = (child) => h(Box, { flexGrow: 1, flexShrink: 1, overflow: 'hidden' }, child)
  const subtle = ui.hex('subtle')
  const cells = Math.max(30, term ? o.W - 2 : o.W - 1)                 // the body, in character cells
  const px = Math.max(240, Math.min(1600, Math.round(cells * PX)))     // the desktop's bars, in px: the full width
  const size = term ? cells : px
  const rule = () => t('─'.repeat(term ? cells : 200), subtle, { wrap: 'truncate' })
  const blank = () => t(' ')
  // Explain mode: small Claude-orange numbers on the parts it explains (superscripts on the terminal, one cell each)
  const ex = ctxExplain
  const expanded = o.expanded ?? ctxExpanded
  const plainT = term ? { plain: true } : {}
  const mark = (n) => (ex ? t(`${term ? SUP[n] : CIRCLED[n]} `, 'claude') : null)
  const markRow = (n, label) => (ex ? row({}, [mark(n), t(label, 'claude')]) : null)
  // Desktop pieces stay on one line: a squeezed piece truncates instead of wrapping word by word
  const one = (s, r) => t(s, r, { wrap: 'truncate' })
  const line = term ? t : one
  // A phone or a thin window: its text runs wider than `cells` counts, so long rows split, cards stack, ⤢ goes
  const narrow = !term && (o.mobile || cells < 72)

  // 1. Title: Context   96k / 200k (48%) … ? More   (the app's own Context window card: name in 'text', figures grey)
  const title = row({ alignItems: 'center' }, [
    row({ alignItems: 'center', flexShrink: 1, overflow: 'hidden' }, [
      line('Context', 'text'), t(narrow ? '  ' : '   '), mark(1), line(view.title.used, 'inactive'),
    ]),
    grow(), t(' '),
    // desktop: native buttons, as design/m4.html and the app's banners draw them; the terminal keeps bare labels
    row({ gap: 1, flexShrink: 0 }, [                                   // spaced as Clear / Compact / Later are
      o.onPopOut && expanded && !narrow ? h(Button, { key: 'ctx-popout', label: '⤢', ...plainT, onPress: o.onPopOut }) : null,
      h(Button, { key: 'ctx-explain', label: '?', ...plainT, onPress: o.onExplain }),
      o.onExpand ? h(Button, { key: 'ctx-expand', label: expanded ? 'Less' : 'More', ...plainT, onPress: o.onExpand }) : null,
    ]),
  ])

  // 2. The context bar, full width, nothing on it
  const barEl = contextBar(ui, geoOf(term, ex ? (term ? cells - 2 : px - 16) : size, 14, 4), view, o.t, o.live, term ? 0 : BAR_PAD)
  const bar = ex ? row({ alignItems: 'center' }, [mark(2), barEl]) : barEl

  // 3. Bottom row: cache and saved on the left, the actions on the right
  const acts = paneActions(view)
  const btn = (k, label, onPress, extra) => h(Button, {
    key: `ctx-${k}`, label, onPress, ...(acts.prim === k ? { variant: 'primary' } : {}), ...(acts.off(k) ? { dimColor: true } : {}), ...extra,
  })
  const buttons = row({ gap: 1, flexShrink: 0 }, [
    btn('clear', 'Clear', o.onClear),
    btn('compact', ctxBusy ? 'Compacting…' : 'Compact', o.onCompact),
    btn('later', 'Later', o.onLater, { role: 'dismiss' }),
  ])
  const c = view.cache
  const sentLen = c.sentence.reduce((n, [s]) => n + s.length, 0)
  const sentence = (tt = t) => c.sentence.map(([s, r]) => tt(s, r))
  // desktop: the whole sentence when it fits beside the three buttons (about 26 columns), else the short words;
  // one line either way: the pieces never wrap, and the left side gives way before the buttons do
  const whole = !term && 6 + sentLen + 3 + view.savings.short.length + 26 <= cells
  const status = row({ alignItems: 'center', flexShrink: 1, overflow: 'hidden' }, [
    mark(3), ...cacheMini(ui, c), t(' '),
    ...(term ? [t(c.short, 'inactive')] : whole && !narrow ? sentence(one) : [one(c.short, 'inactive')]),
    line(' · ', 'inactive'), mark(4), line(view.savings.short, 'inactive'),
  ])
  // narrow: the status on its own line, the buttons under it, so neither squeezes the other to a stub
  const bottom = narrow
    ? col({}, [status, row({ alignItems: 'center', marginTop: 1 }, [grow(), mark(5), buttons])])
    : row({ alignItems: 'center' }, [status, grow(), t(' '), mark(5), buttons])
  // the terminal keeps the bottom row short; the whole sentence sits on its own line under it when it fits
  const under = term && sentLen <= cells ? row({}, sentence()) : null
  const msg = ctxMsg ? t(cap1(ctxMsg), 'inactive', { wrap: 'wrap' }) : null
  const explain = ex ? explainSection(ui, view, o, { row, col, t, grow, rule, cells }) : []
  const hint1M = view.compactHint1M ? t(view.compactHint1M, 'inactive', { wrap: term ? 'wrap' : 'truncate' }) : null
  if (!expanded) return col({}, [title, bar, hint1M, bottom, under, msg, ...explain])

  // 4. Saved: the headline of the whole plugin
  const sv = view.savings
  const ok = ui.hex('success')
  const shades = [ok, mixHex(ok, ui.hex('text'), 0.4), mixHex(ok, CACHE_TRACK, 0.5), mixHex(ok, CACHE_TRACK, 0.75)]
  const srcSum = sv.sources.reduce((n, s) => n + s.tok, 0) || 1
  const parts = sv.sources.map((s, i) => ({ f: (sv.share * s.tok) / srcSum, color: shades[i] }))
  const cut = `Cut ${Math.round(sv.share * 100)}% of input`
  // narrow: "Saved … this session" over "Cut …% of input   ≈ $ · Spent $"
  const savedHead = narrow
    ? col({}, [
        row({}, [one('Saved', 'text'), t(' '), one(`${fmtK(sv.totalTok)} tokens`, 'success'), one(' this session', 'inactive')]),
        row({}, [one(cut, 'text'), grow(), t(' '), ...sv.right.map(([s, r]) => one(s, r))]),
      ])
    : row({}, [
        line('Saved', 'text'), t(' '), line(`${fmtK(sv.totalTok)} tokens`, 'success'), line(' this session · ', 'inactive'), line(cut, 'text'),
        grow(), ...sv.right.map(([s, r]) => line(s, r)),
      ])
  const longKey = sv.sources.reduce((n, s) => n + 3 + s.label.length + fmtK(s.tok).length, 0) + 15
  const label = (s) => (term && longKey > cells ? s.label.split(' ')[0] : s.label)
  const receiptBtn = h(Button, { key: 'ctx-receipt', label: ctxReceipt ? 'Hide receipt' : 'Receipt', onPress: o.onReceipt })
  // narrow: the key as a list, one source a line with its figure at the right, Receipt under it
  const keyRow = narrow
    ? col({}, [
        ...sv.sources.map((s, i) => row({ alignItems: 'center' }, [t('■ ', shades[i]), fit(one(s.label, 'inactive')), num(fmtK(s.tok), 'text', 10)])),
        row({ marginTop: 1 }, [grow(), receiptBtn]),
      ])
    : row({ alignItems: 'center' }, [
        ...sv.sources.flatMap((s, i) => [t('■ ', shades[i]), line(`${label(s)} `, 'inactive'), line(fmtK(s.tok), 'text'), i < sv.sources.length - 1 ? t(term ? ' ' : '    ') : null]),
        grow(), t(' '), receiptBtn,
      ])
  const amtW = sv.priced ? Math.max(11, ...sv.receipt.map((r) => (r.amount || '').length + 1)) : 0
  const receiptLine = (r) => {
    if (r.rule) return rule()
    if (term) {
      const dots = Math.max(1, cells - r.label.length - 2 - 7 - amtW)
      return row({}, [t(r.label, r.role), t(` ${'·'.repeat(dots)} `, subtle), t(r.tok.padStart(7), 'inactive'), amtW ? t(r.amount.padStart(amtW), r.amountRole) : null])
    }
    return row({}, [t(r.label, r.role), h(Box, { flexGrow: 1, flexShrink: 1, overflow: 'hidden', marginX: 1 }, t('·'.repeat(240), subtle, { wrap: 'truncate' })),
      num(r.tok, 'inactive', 8), sv.priced ? num(r.amount, r.amountRole, amtW + 1) : null])
  }
  const receipt = ctxReceipt ? col({}, [rule(), ...sv.receipt.map(receiptLine), t(sv.note, 'inactive')]) : null
  const cacheLine = sv.cacheInfo && sv.cacheInfo.line ? t(sv.cacheInfo.line, 'inactive', { wrap: term ? 'wrap' : 'truncate' }) : null
  const agentLine = sv.agentLine ? t(sv.agentLine, 'inactive', { wrap: term ? 'wrap' : 'truncate' }) : null
  const saved = col({}, [savedHead, savedBar(ui, geoOf(term, size, 10, 3), parts, sv.share, o.t), keyRow, cacheLine, agentLine, receipt])

  // 5. Three cards: what is next, billing (keep-warm or the 5-hour window), the cache
  const cardList = [nextCard(view, avgGrowth()), billCard(view, o.now, o.ttl, o.keepWarmMax, o.longTtl), cacheCard(view)]
  const cardKeys = ['card-next', 'card-bill', 'card-cache']
  // desktop: three across from 110 cells, two from 72, one (full width) on a phone or a thin window
  const perRow = term ? (o.W < 90 ? 2 : 3) : narrow ? 1 : cells < 110 ? 2 : 3
  const gapN = term ? 4 : 3
  const cw = Math.max(16, Math.floor((cells - gapN * (perRow - 1)) / perRow))
  const card = (cd, i) => col(perRow === 1 ? { flexGrow: 1, flexShrink: 1, overflow: 'hidden' } : { width: cw, flexShrink: 0, overflow: 'hidden' }, [
    row({}, [line(cd.title, 'text'), cd.accent ? line(' · ', 'inactive') : null, cd.accent ? line(cd.accent, cd.tone) : null]),
    cardBar(ui, cardKeys[i], geoOf(term, term ? cw : Math.round(cw * PX), 10, 3), cd.bar, o.t, o.cardStyle),
    row({}, [line(cd.strong, 'text'), cd.rest ? line(cd.rest, 'inactive') : null]),
    t(cd.foot, 'inactive', { wrap: 'truncate' }),
    cd.foot2 ? t(cd.foot2, 'inactive', { wrap: 'truncate' }) : null,
  ])
  const cardRows = []
  for (let i = 0; i < cardList.length; i += perRow) {
    if (i) cardRows.push(blank())
    cardRows.push(row({ gap: gapN }, cardList.slice(i, i + perRow).map((cd, j) => card(cd, i + j))))
  }

  // 6. Claude's working memory, like /context: a bar by kind, then a row per kind (narrower figure columns when narrow)
  const numW = narrow ? 8 : 10, pctW = narrow ? 7 : 9
  const memory = col({}, [
    rule(),
    row({}, [line("Claude's working memory", 'text'), grow(), t(' '), line(view.memory.title, 'text')]),
    t('Re-read every time Claude replies or uses a tool', 'inactive'),
    memoryBar(ui, geoOf(term, size, 14, 4), view.memory.parts, o.t),
    ...view.memory.rows.map((r) => row({}, [t('■ ', r.color), fit(t(r.name, r.deferred ? 'inactive' : 'text', { wrap: 'truncate' })),
      num(fmtK(r.tokens), 'inactive', numW), num(r.pct, r.deferred ? 'inactive' : 'text', pctW)])),
  ])

  // 7. Drill-down groups: what is inside each kind, and the command that trims it
  const nameW = term ? Math.max(14, Math.min(30, cells - 4 - 20 - 19)) : narrow ? Math.max(12, Math.floor(cells * 0.4)) : 40
  const groups = (view.groups || []).flatMap((g) => {
    const open = ctxGroups.has(g.id)
    const head = row({ alignItems: 'center' }, [
      h(Button, { key: `ctx-group:${g.id}`, label: open ? '−' : '+', plain: true, onPress: () => o.onGroup(g.id) }), t(' '),
      fit(line(g.label, 'text')), num(fmtK(g.tokens), 'inactive', numW), num(String(g.count), 'inactive', pctW),
    ])
    if (!open) return [head]
    return [
      head,
      ...g.items.map((it) => row({ paddingLeft: narrow ? 2 : 4 }, [
        h(Box, { width: nameW, flexShrink: 0, overflow: 'hidden' }, line(clip(it.name, nameW - 1), 'text')),
        fit(t(it.detail, it.warn ? 'warning' : 'inactive', { wrap: 'truncate' })),
        num(fmtK(it.tokens), 'inactive', numW), num('', 'inactive', pctW),
      ])),
      row({ paddingLeft: narrow ? 2 : 4, alignItems: 'center' }, [
        t('↳ ', 'inactive'), h(Button, { key: `ctx-run:${g.id}`, label: `/${g.cmd}`, onPress: () => o.onRun(g.cmd) }),
        fit(t(`  ${g.what}`, 'inactive', { wrap: 'truncate' })), g.save ? t(`${g.save} each time`, 'success') : null,
      ]),
    ]
  })

  return col({}, [title, bar, hint1M, blank(), markRow(6, 'Saved this session'), saved, blank(), markRow(7, 'Cards: what is next, keep-warm, cache'), ...cardRows, blank(),
    markRow(8, 'Claude’s working memory'), memory, ...(groups.length ? [blank(), markRow(9, 'What is inside each kind, with a button to trim it'), ...groups] : []),
    blank(), bottom, under, msg, ...explain])
}

/**
 * Under the buttons in Explain mode: each numbered part (what it is, its live value, what to do, a way into the
 * glossary), or the glossary itself with one term focused. The terminal wraps its own lines to the body width less 4.
 */
function explainSection(ui, view, o, k) {
  const { Button, term } = ui
  const { row, col, t, grow, rule } = k
  const L = o.L
  const width = Math.max(30, o.W - 4)
  const gl = ctxGloss.open
  const head = row({ alignItems: 'center' }, [
    t(gl ? 'Glossary' : 'Explain this pane', 'text'), grow(), t('Live values, this session', 'inactive'), t(' '),
    gl ? h(Button, { key: 'ctx-glossary-back', label: 'Back to Explain', onPress: o.onGlossaryBack })
      : h(Button, { key: 'ctx-glossary', label: 'Glossary', onPress: () => o.onGlossary(null) }),
  ])
  // one entry: marker, name and what; the live value; → what to do; on Explain, a way into the glossary
  const entry = (lead, name, what, live, todo, more, hot) => {
    const nameColor = hot ? 'claude' : 'text'
    const moreBtn = more ? h(Button, { key: `ctx-more:${more}`, label: 'More in the glossary →', plain: true, onPress: () => o.onGlossary(more) }) : null
    if (term) {
      const first = wrapWords(what, Math.max(10, width - lead.length - name.length - 2))
      const restWhat = first.length > 1 ? wrapWords(first.slice(1).join(' '), width - 3) : []
      return [
        row({}, [t(lead, 'claude'), t(name, nameColor), t(`  ${first[0] || ''}`, 'inactive')]),
        ...restWhat.map((l) => t(`   ${l}`, 'inactive')),
        ...(live ? wrapWords(live, width - 3).map((l) => t(`   ${l}`, 'text')) : []),
        ...(todo ? wrapWords(`→ ${todo}`, width - 3).map((l) => t(`   ${l}`, 'inactive')) : []),
        moreBtn ? row({ paddingLeft: 3 }, [moreBtn]) : null,
      ]
    }
    return [row({ marginTop: 1 }, [t(lead, 'claude'), col({ flexGrow: 1, flexShrink: 1 }, [
      row({ flexWrap: 'wrap' }, [t(name, nameColor), t(`  ${what}`, 'inactive', { wrap: 'wrap' })]),
      live ? t(live, 'text', { wrap: 'wrap' }) : null,
      todo ? t(`→ ${todo}`, 'inactive', { wrap: 'wrap' }) : null,
      moreBtn,
    ])])]
  }
  const body = []
  if (gl) {
    for (const g of glossaryFor(L)) {
      body.push(row({ marginTop: term ? 0 : 1 }, [t(g.group, 'claude')]))
      for (const tm of g.terms) {
        const hot = ctxGloss.focus === tm.id
        body.push(...entry(hot ? '▸ ' : '  ', tm.name, tm.what, tm.live, tm.todo, null, hot))
      }
    }
  } else {
    for (const [n, name, what, live, todo, id] of explainEntries(view, L, o.expanded ?? ctxExpanded)) {
      body.push(...entry(`${term ? SUP[n] : CIRCLED[n]} `, name, what, live, todo, id, false))
    }
  }
  return [rule(), head, ...body].filter(Boolean)
}

// ---- Explain this pane, and the glossary (hooks/glossary.js, one source for the pane and /tokens learn) ----
let ctxExplain = false
let ctxGloss = { open: false, focus: null }
const SUP = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const CIRCLED = '⓪①②③④⑤⑥⑦⑧⑨'
const money = (x) => '$' + x.toFixed(2)

/** Words to lines of at most `width` cells; a word longer than the line is left whole. */
function wrapWords(text, width) {
  const out = []
  let line = ''
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line + ' ' + w).length > width) { out.push(line); line = w } else line = line ? line + ' ' + w : w
  }
  if (line) out.push(line)
  return out
}

/**
 * The live numbers the glossary and Explain read, from this session's real state. A number we do not have stays
 * undefined, and its live line is dropped. `api` is "not a subscription": dollars appear only when a rate is known
 * (`priced`), and never on a subscription.
 */
function liveNumbers(view, s) {
  const b = view.breakdown, sv = view.savings, c = view.cache
  const api = sv.mode !== 'subscription'
  const priced = sv.priced
  const usdOf = (tok) => (priced ? money((tok * sv.rate) / 1e6) : undefined)
  const pctOf = (n) => `${((100 * n) / view.measure).toFixed(1)}%`
  const rows = (b && view.memory.rows) || []
  const sum = (pred) => { const r = rows.filter(pred); return r.length ? r.reduce((n, x) => n + x.tokens, 0) : undefined }
  const live = (k) => sum((r) => !r.deferred && r.key === k)
  const messages = live('messages'), mcp = live('mcp'), skills = live('skills'), system = live('system'), sysTools = live('tools'), memory = live('memory')
  const mcpDef = sum((r) => r.deferred && r.key === 'mcp'), sysDef = sum((r) => r.deferred && r.key !== 'mcp')
  const buffer = sum((r) => r.key === 'buffer'), free = sum((r) => r.key === 'free')
  const tools = (b && Array.isArray(b.mcpTools) && b.mcpTools) || []
  const mem = (b && Array.isArray(b.memoryFiles) && b.memoryFiles) || []
  const memGroup = (view.groups || []).find((g) => g.id === 'memory')
  const k = (n) => (n === undefined ? undefined : fmtK(n))
  const next = view.nextMark, avg = avgGrowth()
  const left = next ? Math.max(0, (view.measure * next.pct) / 100 - view.used) : 0
  const msgs = next && avg > 0 ? Math.max(1, Math.ceil(left / avg)) : 0
  const ttlMin = Math.max(1, Math.round(s.ttl / MINUTE))
  const amt = c.amount
  const warmCost = usdOf(view.used * 0.1), coldCost = usdOf(view.used * 1.25)
  const five = view.five
  let windowResets
  const r = five && five.resetsAt ? Date.parse(five.resetsAt) : NaN
  if (Number.isFinite(r)) { const ms = Math.max(0, r - s.now); windowResets = `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / MINUTE)}m` }
  const usedPings = Number.isFinite(keepWarm.streak) ? Math.min(keepWarm.streak, s.keepWarmMax) : s.keepWarmMax
  const T = s.totals
  return {
    api, priced, used: fmtK(view.used), win: view.window ? fmtK(view.window) : undefined, pct: view.window ? view.pct : undefined,
    requests: T.turns, rate: priced ? money(sv.rate) : undefined,
    messages: k(messages), messagesPct: messages === undefined ? undefined : pctOf(messages), mcp: k(mcp), mcpPct: mcp === undefined ? undefined : pctOf(mcp),
    mcpServers: tools.length ? new Set(tools.filter((t) => t.isLoaded !== false).map((t) => t.serverName)).size : undefined,
    mcpDeferred: mcpDef === undefined && sysDef === undefined ? undefined : fmtK(mcpDef || 0), sysDeferred: mcpDef === undefined && sysDef === undefined ? undefined : fmtK(sysDef || 0),
    skills: k(skills), skillCount: b && b.skills ? Number(b.skills.totalSkills) || undefined : undefined,
    system: k(system), sysTools: k(sysTools), memory: k(memory), memoryCount: mem.length || undefined, memoryTwice: !!(memGroup && memGroup.save),
    buffer: k(buffer), free: k(free),
    cacheLine: !c.known ? 'No reply yet, so nothing is cached.'
      : c.warm ? `Warm, ${c.leftMin}m left: your next message reuses ${amt}${priced ? ` (≈ ${warmCost} instead of ${coldCost})` : ''}.`
      : `Cold: your next message re-processes ${amt}${priced ? ` (≈ ${coldCost})` : ''}.`,
    cacheState: !c.known ? 'Not started: the clock begins after the first reply.' : !c.warm ? 'Cold.' : c.cooling ? `Cooling: ${c.leftMin}m left.` : `Warm: ${c.leftMin}m left.`,
    switchLine: view.switchCost ? view.switchCost.line : '',
    cacheWarm: c.known && c.warm, ttl: ttlMin >= 60 ? 'One hour' : `${ttlMin} minutes`, coldCost, hit: lastUsage ? hitPct(lastUsage) : undefined,
    keepWarmOn: keepWarm.on && s.keepWarmMax > 0, keepWarmWhy: keepWarm.stopped || (s.longTtl ? 'the one-hour cache rarely lapses' : 'turned off in /config'),
    pings: usedPings, pingCap: s.keepWarmMax,
    nextMark: next ? `Next: ${next.id} at ${next.pct}%${msgs ? `, about ${msgs} message${msgs === 1 ? '' : 's'} away` : ''}.` : 'Past every mark.',
    auto: view.compactPct === null ? undefined : view.compactPct,
    saved: fmtK(sv.totalTok), savedUsd: usdOf(sv.totalTok), share: Math.round(sv.share * 100), cacheRead: fmtK(T.cacheRead),
    keptOut: fmtK(sv.sources[0].tok), keptRequests: T.turns, rewrites: s.rewrites, vetoes: s.vetoes, vetoTok: fmtK(sv.sources[1].tok), warmNet: fmtK(sv.sources[2].tok),
    agentLapses: T.agentLapses || 0, agentLapseTok: fmtK(T.agentLapseTok || 0), agentLine: sv.agentLine || '',
    windowUsage: five ? pct100(five.percentUsed) : undefined, windowResets,
    // for Explain
    _msgs: msgs, _left: left,
  }
}

/** The glossary with this session's numbers; a live line that needed a number we lack is left out. */
function glossaryFor(L) {
  const bad = /undefined|NaN|null/
  return GLOSSARY(L).map((g) => ({
    group: g.group,
    terms: g.terms.map((t) => ({ ...t, live: typeof t.live === 'string' && !bad.test(t.live) ? t.live : '', todo: t.todo || '' })),
  }))
}

/** The numbered parts of the pane, as design/m4.js explainEntries words them: [n, name, what, live, todo, termId]. */
function explainEntries(view, L, open) {
  const next = view.nextMark, c = view.cache, sv = view.savings
  const colour = ['blue (calm)', 'amber (past watch)', 'orange (past handoff)', 'red (past compact)'][view.crossed]
  const msgs = L._msgs
  const acts = paneActions(view)
  const card = nextCard(view, avgGrowth())
  const runway = /^Runway (\d+)%$/.exec(card.strong)
  const live3 = !c.known ? 'No reply yet, so nothing is cached.'
    : c.warm ? `Warm, ${c.leftMin}m left: your next message reuses ${c.amount}${L.priced && L.coldCost ? ` (≈ ${money((view.used * 0.1 * sv.rate) / 1e6)} instead of ${L.coldCost})` : L.api ? ' at a tenth of the price' : ' at a tenth of the usage'}.`
    : `Cold: your next message re-processes ${c.amount}${L.priced && L.coldCost ? ` (≈ ${L.coldCost})` : ''}.`
  const entries = [
    [1, 'Context', 'How full Claude’s working memory is: everything it has to read again before it can answer.',
      `${L.used}${L.win ? ` of ${L.win}` : ''} tokens${L.win ? ` (${view.pct}%)` : ''}.${next ? ` Next mark: ${next.id} at ${next.pct}%${msgs ? `, about ${msgs} message${msgs === 1 ? '' : 's'} away` : ''}.` : ''}`,
      next && next.hint === 'new-conversation' ? 'Before it fills, write a handoff, then Clear.' : 'Keep one task per conversation; Clear when the topic changes.', 'context'],
    [2, 'The bar', 'The same number, drawn. Its colour follows your marks, and the ticks show where they are.',
      `Now ${colour}. Marks at ${view.marksAll.map((m) => m.pct + '%').join(', ')}${view.compactPct === null ? '' : `; auto-compact at ${view.compactPct}%`}.`, '', 'marks'],
    [3, 'Cache', 'Anthropic keeps a copy of this conversation for a while. Reusing it costs a tenth; letting it lapse means paying again in full.',
      `${live3}${L.switchLine ? ` ${L.switchLine}` : ''}`, c.known && c.warm ? 'Reply before it cools, and avoid editing CLAUDE.md mid-session.' : 'Clear beats Compact while cold: compacting would pay for everything again.', 'cache'],
    [4, 'Saved', 'Tokens the plugin kept off your bill this session.',
      !c.known && !sv.totalTok ? 'Nothing yet: it counts from the first reply.' : `${L.saved} tokens${L.savedUsd ? ` ≈ ${L.savedUsd}` : ''}, ${L.share}% of what you would have sent.`, 'Press Open on the band to see where it came from.', 'saved'],
    [5, 'Clear · Compact · Later', 'Clear starts fresh. Compact shrinks the conversation into a summary, cheap only while the cache is warm. Later closes this.',
      `Recommended now: ${{ clear: 'Clear', compact: 'Compact', later: 'Later' }[acts.prim]}.`, '', 'compact'],
  ]
  if (open) {
    const used = view.memory.rows.filter((r) => !r.deferred && r.key !== 'free' && r.key !== 'buffer').sort((a, b) => b.tokens - a.tokens)
    const mcpGroup = (view.groups || []).find((g) => g.id === 'mcp')
    const billing = view.savings.mode === 'subscription' && view.five ? `Usage ${pct100(view.five.percentUsed)}% of the 5-hour window` : L.keepWarmOn ? `Pings ${L.pings} of ${L.pingCap}` : 'Keep-warm off'
    entries.push(
      [6, 'Saved this session', 'Only what the plugin did: trimmed tool output, cold compactions it vetoed, and keep-warm pings net of their cost. Claude\'s own prompt cache is shown beside it, never added in.',
        `Trimmed ${L.keptOut} · Vetoed ${L.vetoTok} · Keep-warm ${L.warmNet} · Cache read ${L.cacheRead}, not counted.`, 'Press Receipt for the money, line by line.', 'cut'],
      [7, 'The cards', 'What is coming (your next mark), what keeps the cache alive while you are away, and how long it stays warm.',
        `Runway ${runway ? runway[1] : 100}% · ${billing} · ${c.known && c.warm ? `${c.leftMin}m left` : 'Cold'}.`, '', 'keepwarm'],
      [8, 'Claude’s working memory', 'Everything Claude re-reads each time it replies or uses a tool, by kind.',
        used.length ? `Biggest: ${used[0].name} ${fmtK(used[0].tokens)} (${used[0].pct})${used[1] ? `, then ${used[1].name.toLowerCase()} ${fmtK(used[1].tokens)}` : ''}.` : '',
        'Smaller memory means cheaper replies and more room before compaction.', 'mcp'],
      [9, 'Groups', 'What is inside each kind, with a button that trims it.',
        mcpGroup && mcpGroup.tokens ? `Turning off unused MCP servers could save up to ${fmtK(mcpGroup.tokens)} each time.` : '', 'Open a group, then press its button.', 'deferred'],
    )
  }
  return entries
}

/** `/tokens learn [term]`: the glossary as plain text, grouped; or the terms whose id or name match. */
function learnText(L, query) {
  const groups = glossaryFor(L)
  const term = (t) => [`${t.name}: ${t.what}`, ...(t.live ? [`  ${t.live}`] : []), ...(t.todo ? [`  → ${t.todo}`] : [])].join('\n')
  const q = String(query || '').trim().toLowerCase()
  if (!q) return ['Glossary · live values from this session', ...groups.map((g) => `\n${g.group}\n${g.terms.map(term).join('\n')}`)].join('\n')
  const all = groups.flatMap((g) => g.terms)
  let hits = all.filter((t) => t.id === q || t.name.toLowerCase() === q)
  if (!hits.length) hits = all.filter((t) => t.id.includes(q) || t.name.toLowerCase().includes(q))
  if (!hits.length) return `No term matches "${query.trim()}". Terms: ${all.map((t) => t.name).join(', ')}. /tokens learn prints them all.`
  return hits.map(term).join('\n\n')
}

function toast($, text, timeoutMs = 6000) {
  try { $.ui.toast(text, { timeoutMs }) } catch { /* no UI */ }
}

function invalidate($) {
  try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
}

/** Carry this session's savings into a per-month total in $.store, adding only what is new since the last roll. */
async function rollMonth($) {
  try {
    const key = `saved:${new Date().toISOString().slice(0, 7)}`
    const sessionTok = Math.max(0, totals.keptOut + Math.round(totals.vetoTokens * 1.25) + Math.round(totals.switchHeld * 1.25) + keepWarm.savedTok - keepWarm.costTok)
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
    if (agentTypes.size) agentWeeks = await loadAgentWeeks($, now)   // "lapsed N times this week", only once an agent has run
    ctxCache = { at: now, usage }
    return ctxCache
  })().finally(() => { ctxLoading = null })
  return ctxLoading
}

/**
 * /tokens list: the Context pane as a table, a row per card: the card, its headline figure, the detail.
 * The figures are the pane's own (contextView, nextCard, billCard), so the two never disagree. Fits `columns`.
 */
function listText(view, o) {
  const bar = (f, n = 20) => { const k = Math.round(clamp01(f) * n); return '█'.repeat(k) + '░'.repeat(n - k) }
  const low = (s) => String(s || '').replace(/^ · /, '').replace(/^[A-Z](?=[a-z])/, (ch) => ch.toLowerCase())   // acronyms (MCP) keep their case
  const dots = (...facts) => facts.filter(Boolean).join(' · ')
  const c = view.cache, sv = view.savings
  const rows = []
  rows.push(['Context', view.window ? `${fmtK(view.used)} of ${fmtK(view.window)} (${view.pct}%)` : `${fmtK(view.used)} tokens`, bar(view.pct / 100)])
  rows.push(['Cache', c.short, dots(c.sentence.map((p) => p[0]).join('').replace(/^[^:]*: /, ''), c.known ? low(c.rest) : '')])
  rows.push(['Saved', `${fmtK(sv.totalTok)} tokens${sv.priced ? ` ≈ $${((sv.totalTok * sv.rate) / 1e6).toFixed(2)}` : ''}`, dots(...sv.sources.map((x) => `${low(x.label)} ${fmtK(x.tok)}`))])
  if (sv.agentLapses > 0) rows.push(['Agents', `${sv.agentLapses} re-read${sv.agentLapses === 1 ? '' : 's'} after a long wait · ${fmtK(sv.agentLapseTok)} tokens`, sv.agentLine ? low(sv.agentLine) : 'not a saving: an agent that waits over 5 minutes re-reads what it had'])
  rows.push(['Keep-warm', keepWarm.on ? 'on' : `off${keepWarm.stopped ? ` (${keepWarm.stopped})` : ''}`,
    keepWarm.on ? `${keepWarm.pings} ping${keepWarm.pings === 1 ? '' : 's'} · avoided ${fmt(keepWarm.savedTok)} · spent ${fmt(keepWarm.costTok)} tokens` : ''])
  if (sv.mode === 'subscription' && view.five) {
    const b = billCard(view, o.now, o.ttl, o.keepWarmMax, o.longTtl)
    rows.push(['5-hour window', dots(low(b.strong), low(b.rest)), low(b.foot)])
  }
  if (view.breakdown) {
    const top = view.memory.rows.filter((r) => !r.deferred && r.key !== 'free' && r.key !== 'buffer' && r.tokens > 0).sort((x, y) => y.tokens - x.tokens).slice(0, 5)
    if (top.length) rows.push(['Memory', `${low(top[0].name)} ${fmtK(top[0].tokens)}`, dots(...top.slice(1).map((r) => `${low(r.name)} ${fmtK(r.tokens)}`))])
  }
  const n = nextCard(view, avgGrowth())
  rows.push(['Next', `${n.title} ${low(n.accent)}`, dots(low(n.strong), low(n.rest), low(n.foot))])

  // column widths: the first two fit their widest cell, the detail takes what is left of the terminal and is clipped
  const cols = Math.max(60, Number(o.columns) || 100)
  const w0 = Math.max(...rows.map((r) => r[0].length)), w1 = Math.max(...rows.map((r) => r[1].length))
  const w2 = Math.max(10, Math.min(Math.max(...rows.map((r) => r[2].length)), cols - w0 - w1 - 10))
  const line = (l, m, r) => `${l}${'─'.repeat(w0 + 2)}${m}${'─'.repeat(w1 + 2)}${m}${'─'.repeat(w2 + 2)}${r}`
  const cell = (t, w) => ` ${clip(t, w).padEnd(w)} `
  const out = [line('┌', '┬', '┐')]
  for (const r of rows) out.push(`│${cell(r[0], w0)}│${cell(r[1], w1)}│${cell(r[2], w2)}│`)
  out.push(line('└', '┴', '┘'))
  out.push(dots('/tokens opens the pane', '/tokens learn explains each row', '/tokens hide|show the band', 'marks: ~/.claude/token-saver/thresholds.json', o.compactGuard ? 'a vetoed /compact: /compact force' : '',
    view.compactHint1M ? low(view.compactHint1M) : ''))   // a 1M window compacting near the top: the one setting worth changing today
  return out.join('\n')
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

/** Open the Context pane, as /tokens does. False where panes are not drawn (the caller answers in text). */
async function openContextPane($) {
  ctxCache.at = 0
  try {
    const opened = await $.ui.open({ id: CONTEXT_PANE, title: 'Context', focus: true, closeOnEscape: true, holdToasts: true, rows: 10 })
    if (!opened || opened.isPlaced !== false) {
      ctxMsg = ''
      ctxPaneOpen = true
      await rollMonth($)
      return true
    }
    // not placed: say why, instead of a button that does nothing
    try { $.ui.toast(`Context pane not shown: ${opened.reason || 'the window is too narrow'}. Try /tokens.`, { timeoutMs: 8000 }) } catch { /* no UI */ }
  } catch (err) {
    try { $.ui.toast(`Context pane could not open: ${err && err.message ? err.message : String(err)}`, { timeoutMs: 8000 }) } catch { /* no UI */ }
  }
  return false
}

/** The band's figures: one plain usage call (no breakdown), cached a second so the 70 ms redraws cost nothing. */
let bandCtx = { at: 0, usage: null }
async function bandUsage($, now) {
  if (bandCtx.at && now - bandCtx.at < 1000) return bandCtx.usage
  let usage = null
  try { usage = await $.session.usage() } catch { usage = null }
  if (!(usage && usage.context)) usage = { ...(usage || {}), context: { tokens: sentOf(lastUsage) } }
  bandCtx = { at: now, usage }
  return usage
}

/** The band's cache words: the pane's sentence, short. */
/** Spaces at the ends of a text piece collapse on the desktop; no-break spaces keep the gaps. */
function nbsp(s) {
  return typeof s === 'string' ? s.replace(/^ +| +$/g, (m) => '\u00a0'.repeat(m.length)) : s
}

/** The band's second line, past a mark: what to do now, in the pane's words. */
function bandHint(pct, clock) {
  const hit = [...levels].filter((l) => Number(l.pct) <= pct).sort((a, b) => b.pct - a.pct)[0]
  if (!hit) return ''
  const warm = clock && clock.known && clock.warm
  const left = warm ? ` (${mins(clock.leftMs)}m left)` : ''
  if (hit.id === 'compact') return warm ? `Past your compact mark (${hit.pct}%): Compact now, while the cache is warm${left}` : `Past your compact mark (${hit.pct}%): Clear, since Compact would pay for everything again`
  if (hit.id === 'handoff') return `Past your handoff mark (${hit.pct}%): write a handoff, then Clear`
  return `Past your ${hit.id} mark (${hit.pct}%): note decisions as you go`
}

/** A drill-down group's command (/mcp, /memory, /agents, /loadout): close the pane, then run it as /clear does. */
async function runFromPane($, command) {
  ctxPaneOpen = false; ctxPopped = false
  try { await $.ui.close({ id: CONTEXT_PANE }) } catch { /* already closed */ }
  try {
    await $.command.run({ command })
  } catch (err) {
    toast($, `token-saver: could not run /${command} (${err && err.message ? err.message : String(err)}) — type /${command}`)
  }
}

/**
 * Run a slash command as the person would. From a press: $.command.run (the host refuses $.prompt.submit of a
 * '/' text). Inside a command.run hook, where command.run is refused too: draft it in the box for Enter.
 * Resolves 'ran' or 'filled'; rejects when neither works.
 */
async function submitCommand($, command, { inCommandHook = false } = {}) {
  if (!inCommandHook) {
    await $.command.run({ command, args: '' })
    return 'ran'
  }
  const r = await $.prompt.fill({ text: `/${command}` })
  if (r && r.isFilled === false) throw new Error(`could not draft /${command}`)
  toast($, `token-saver: /${command} is in the prompt box — press Enter`, 8000)
  return 'filled'
}

/** Compact from the pane: the mod's own guard (cold cache → veto, keep-list) applies as it does to a typed /compact. */
export async function compactNow($, ttl, compactGuard, { inCommandHook = false } = {}) {
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
      let r
      try {
        r = await $.session.compact({})
      } catch (err) {
        // The desktop and other SDK hosts compact only inside a turn: run /compact as the person would
        if (!/headless|not available/i.test(String(err && err.message))) throw err
        r = { queued: await submitCommand($, 'compact', { inCommandHook }) }
      }
      if (r && r.queued === 'filled') ctxMsg = 'compact: /compact is in the prompt box, press Enter'
      else if (r && r.queued) ctxMsg = 'compacting: /compact sent'
      else if (r && r.skip) ctxMsg = `compact skipped: ${r.skip}`
      else if (r && Number.isFinite(r.tokensBefore)) ctxMsg = `compacted ${fmtK(r.tokensBefore)} → ${Number.isFinite(r.tokensAfter) ? fmtK(r.tokensAfter) : '?'}`
      else ctxMsg = 'compacted'
    }
  } catch (err) {
    ctxMsg = `compact failed: ${String(err && err.message ? err.message : err).replace(/^token-saver:\s*/, '')} — type /compact`
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

/* Per-load settings the module-level renderers read (set once in register). */
let ENV = { ttl: TTL_SHORT, options: {}, keepWarmMax: 5, cardBars: 'fire', compactGuard: true, inputPricePerM: 0 }

/* The Context pane's drawing, shared: the terminal shows it in a real Pane; the desktop app (its Code tab has no
   slot for plugin panes, so a Pane there is never drawn) shows it in the band above the prompt instead. */
/** The Context pane's tree. `inBand`: drawn above the prompt (desktop), where ⤢ opens the real pane. */
async function renderContext($, e, inBand) {
const { ttl, options, keepWarmMax, cardBars, compactGuard, inputPricePerM } = ENV
  try {
    const el = $.ui.resolve(e)
    const term = e.surface === 'terminal'
    const pal = THEME_HEX[term ? 'terminal' : 'desktop']
    const ui = {
      Box: el.Box, Text: el.Text, Button: el.Button, Svg: term ? undefined : el.Svg, Raster: term ? el.Raster : undefined, term,
      hex: (k) => (String(k).startsWith('#') ? k : pal[k] || pal.inactive),
    }
    const popped = !inBand && ctxPopped                             // the Pane ⤢ opened: always open, its own frame
    const W = (e.props && e.props.bodyColumns) || (e.viewport && e.viewport.columns) || 80
    const now = await $.clock.now()
    const data = await loadContext($, now, W)
    if (homeCache === null) { try { homeCache = await homeDir($) } catch { homeCache = '' } }
    const clock = cacheClock(now, ttl)
    const view = contextView(data.usage, ttl, lastUsage, clock, { rewrites, savedChars, vetoes, totals, rate: inputPricePerM, limitBase, month: monthSaved, keepWarm, agents: { types: agentTypes, weeks: agentWeeks } })
    view.groups = drillGroups(view.breakdown, homeCache)
    const L = ctxExplain ? liveNumbers(view, { ttl, now, keepWarmMax, longTtl: !!options.longCacheTtl, totals, rewrites, vetoes }) : null
    return drawContextPane(ui, view, {
      W, mobile: e.surface === 'mobile', t: progressTick * TICK_S, now, ttl, keepWarmMax, longTtl: !!options.longCacheTtl, cardStyle: cardBars, live: clock.known, L,
      // desktop, on a surface that places panes (what More used to do there): ⤢ moves the open band into a
      // Pane of its own, always open, and the band folds back
      expanded: popped ? true : undefined,
      onPopOut: inBand && !term && e.viewport && e.viewport.isFullscreen === true ? async () => { if (await openContextPane($)) { ctxPopped = true; ctxExpanded = false; invalidate($) } } : undefined,
      onExplain: () => { ctxExplain = !ctxExplain; if (!ctxExplain) ctxGloss = { open: false, focus: null }; invalidate($) },
      onGlossary: (focus) => { ctxGloss = { open: true, focus }; invalidate($) },
      onGlossaryBack: () => { ctxGloss = { open: false, focus: null }; invalidate($) },
      onExpand: popped ? undefined : () => { ctxExpanded = !ctxExpanded; ctxCache.at = 0; invalidate($) },   // More / Less: open in place
      onReceipt: () => { ctxReceipt = !ctxReceipt; invalidate($) },
      onGroup: (id) => { if (ctxGroups.has(id)) ctxGroups.delete(id); else ctxGroups.add(id); invalidate($) },
      onRun: (cmd) => runFromPane($, cmd),
      onClear: () => clearSession($),
      onCompact: () => compactNow($, ttl, compactGuard),
      onLater: inBand ? () => {
        if (ctxExpanded) { ctxExpanded = false; invalidate($); return }       // open: fold back to the closed frame
        bandHidden = true; invalidate($)                                      // closed: put the band away for this session
        try { $.ui.toast('Context band hidden. /tokens show brings it back.', { timeoutMs: 6000 }) } catch { /* no UI */ }
      } : async () => { ctxPaneOpen = false; ctxPopped = false; try { await $.ui.close({ id: CONTEXT_PANE }) } catch { /* closed */ } },
    })
  } catch (err) {
    const { Text } = $.ui.resolve(e)
    return h(Text, { color: '#e5484d' }, `token-saver: context pane failed: ${err && err.stack ? err.stack.split('\n').slice(0, 2).join(' ') : String(err)}`)
  }
}


export function register(on, options = {}) {
  const quietBash = options.quietBash !== false
  const trimOutput = options.trimOutput !== false
  const cacheBand = options.cacheBand !== false
  const compactHint = options.compactHint !== false
  const compactGuard = options.compactGuard !== false
  const modelGuard = options.modelGuard !== false
  const inputPricePerM = Number(options.inputPricePerM) || 0
  const suggestSkills = options.suggestSkills !== false
  const ttl = options.longCacheTtl ? TTL_LONG : TTL_SHORT
  // Keep-warm pings only make sense against the 5-minute TTL; with the 1-hour TTL a lapse is already rare
  const keepWarmMax = Math.max(0, Math.round(Number(options.keepWarmPings ?? 5)))
  const cardBars = options.cardBars === 'ember' ? 'ember' : 'fire'
  ENV = { ttl, options, keepWarmMax, cardBars, compactGuard, inputPricePerM }
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
        description: 'Context pane: window fill, rate limits, cache warmth, Clear / Compact; ? explains it. /tokens list prints it as text; /tokens learn [term] prints the glossary. No model turn.',
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
      const bandOn = cacheBand && !!lastUsage && !bandHidden      // the band's bar burns while it shows; hidden, it costs nothing
      // The desktop holds a Button's press for the drawing it came from: redrawn every 140 ms, most clicks land on a
      // drawing already gone. So the band redraws there only on news (and BAND_TICK); its bars animate by themselves,
      // a SMIL loop inside each Svg (cellBar).
      const bandAnimates = bandOn && bandSurface === 'terminal'
      const paneAnimates = ctxPaneOpen && bandSurface === 'terminal'   // the desktop draws the open pane in the band: same rule
      if (progressRows.size === 0 && !ctxPaneOpen && !bandOn) return
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
      if (changed || moving || animating || ((paneAnimates || bandAnimates) && progressTick % 2 === 0)) {
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

  // /clear, typed or from the pane's Clear: say what it freed. Before the clear the engine reports the window's
  // fill; after it the window holds at most the next session's preamble. Freed is the difference (≈: the preamble
  // is read again on the next turn, and a build that still reports the old fill after the clear counts as empty).
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    let before = null
    try { before = await contextOf($) } catch { before = null }
    const r = await next(e)
    let after = 0
    try { after = (await contextOf($)).tokens || 0 } catch { after = 0 }
    lastUsage = null                                   // the band and the pane start from the new window
    announcedPct = 0
    growth.length = 0
    turnStartTokens = null
    bandCtx = { at: 0, usage: null }
    ctxCache = { at: 0, usage: null }
    const freed = before && before.tokens > 0 ? before.tokens - (after < before.tokens ? after : 0) : 0
    if (freed > 0) {
      const of = before.window > 0 ? ` (${Math.round((100 * freed) / before.window)}% of ${fmt(before.window)})` : ''
      const msg = `Cleared: ≈${fmt(freed)} tokens freed${of}`
      try { $.ui.log(msg) } catch { /* no UI */ }
      toast($, msg, 8000)
    }
    return r
  })
  on('command.run', { command: 'tokens' }, async ($, e) => {
    const arg = (e.args || '').trim().toLowerCase()
    if (arg === 'learn' || arg.startsWith('learn ')) {
      // The glossary as text, with this session's numbers: /tokens learn [term or id]
      const now = await $.clock.now()
      const data = await loadContext($, now, 80)
      if (homeCache === null) { try { homeCache = await homeDir($) } catch { homeCache = '' } }
      const view = contextView(data.usage, ttl, lastUsage, cacheClock(now, ttl), { rewrites, savedChars, vetoes, totals, rate: inputPricePerM, limitBase, month: monthSaved, keepWarm, agents: { types: agentTypes, weeks: agentWeeks } })
      view.groups = drillGroups(view.breakdown, homeCache)
      const L = liveNumbers(view, { ttl, now, keepWarmMax, longTtl: !!options.longCacheTtl, totals, rewrites, vetoes })
      return { text: learnText(L, (e.args || '').trim().slice(5)) }
    }
    if (arg === 'hide' || arg === 'show') {
      bandHidden = arg === 'hide'
      try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
      return { text: bandHidden ? 'band hidden for this session · /tokens show brings it back' : 'band shown' }
    }
    if (arg === '' || arg === 'pane') {
      // The Context pane: the engine's own context dialog, drawn by the mod. Text where panes do not draw (vscode).
      // desktop: shown above the prompt, unless the surface places panes (then the Pane below is the one)
      if (!(e.presentation && e.presentation.isFullscreen === true)) { ctxExpanded = true; invalidate($) }
      if (await openContextPane($)) return { text: 'Context pane opened. Esc closes it. /tokens list prints the same as text.' }
    }
    // /tokens list: the pane's cards as text, one line each, from the same view the pane draws.
    const now = await $.clock.now()
    const data = await loadContext($, now, 80)
    const view = contextView(data.usage, ttl, lastUsage, cacheClock(now, ttl), { rewrites, savedChars, vetoes, totals, rate: inputPricePerM, limitBase, month: monthSaved, keepWarm, agents: { types: agentTypes, weeks: agentWeeks } })
    return { text: listText(view, { now, ttl, keepWarmMax, longTtl: !!options.longCacheTtl, compactGuard, columns: e.presentation && e.presentation.columns }) }
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
  // Per-message growth for the pane's "In ≈N messages": context at turn.start against context at turn.complete
  on('turn.start', async ($, e, next) => {
    inTurn = true
    try {
      const c = await contextOf($)
      turnStartTokens = Number.isFinite(c.tokens) ? c.tokens : null
    } catch {
      turnStartTokens = null
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    try {
      return await next(e)
    } finally {
      inTurn = false
      if (e.agentId && agents.has(e.agentId)) {          // a subagent's answer: fold its run into its type's sums
        const rec = agents.get(e.agentId)
        agents.delete(e.agentId)
        await rollAgent($, rec)
      }
      if (oneShot && !e.agentId) {
        oneShot = null
        try { $.ui.status(undefined) } catch { /* no UI */ }
      }
      if (turnStartTokens !== null) {
        const before = turnStartTokens
        turnStartTokens = null
        try {
          const d = (await contextOf($)).tokens - before
          if (d > 0) {                                   // a compaction mid-turn shrinks it: not growth
            growth.push(d)
            if (growth.length > GROWTH_KEEP) growth.shift()
          }
        } catch { /* no usage API */ }
      }
    }
  })

  on('turn.step', async function* ($, e, next) {
    const result = yield* next(oneShot && !e.agentId ? { ...e, model: oneShot.model } : e)   // 'One message' from the switch guard
    if (e.agentId && result && result.usage) {
      // A subagent's step: its own cache clock, never the main thread's. A gap past the 5-minute TTL followed by a
      // request that missed (the context written again, not read) is a lapse; a gap followed by a hit means a longer
      // TTL was already in force and nothing was lost.
      const stepAt = await $.clock.now()
      const a = agents.get(e.agentId) || { type: 'subagent', model: e.model || '', lastStepAt: 0, lapses: 0, lapseWrite: 0, otherWrite: 0, steps: 0 }
      agents.set(e.agentId, a)
      if (e.model) a.model = e.model
      const write = result.usage.cache_creation_input_tokens || 0
      if (a.lastStepAt && stepAt - a.lastStepAt > TTL_SHORT && write > 0 && hitPct(result.usage) < 50) {
        a.lapses += 1
        a.lapseWrite += write
        totals.agentLapses += 1
        totals.agentLapseTok += Math.round(write * 1.25)
        try { $.ui.invalidate('ui.render') } catch { /* no UI */ }
      } else {
        a.otherWrite += write
      }
      a.lastStepAt = stepAt
      a.steps += 1
    }
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

  // Subagent identity: the classic SubagentStart input names the agent's type (Explore, Plan, a plugin's agent);
  // turn.step only carries the id. Stop clears a record whose turn.complete never came. Neither changes the event.
  on('classic.SubagentStart', ($, e, next) => {
    if (e && e.agent_id) {
      const a = agents.get(e.agent_id) || { type: 'subagent', model: '', lastStepAt: 0, lapses: 0, lapseWrite: 0, otherWrite: 0, steps: 0 }
      a.type = String(e.agent_type || a.type || 'subagent')
      agents.set(e.agent_id, a)
    }
    return next(e)
  })
  on('classic.SubagentStop', async ($, e, next) => {
    if (e && e.agent_id && agents.has(e.agent_id)) {
      const rec = agents.get(e.agent_id)
      agents.delete(e.agent_id)
      await rollAgent($, rec)
    }
    return next(e)
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

  /**
   * Model-switch guard. The engine's own "Switch model?" dialog has no number in it; this event has them all
   * (context_tokens, prompt_cache_warm, and a list-price estimate of re-caching on the target model):
   *  - cache cold, or under SWITCH_CHEAP tokens: allowed, one toast says why it is free or cheap
   *  - warm and large: one dialog with the cost and three ways out — Switch, One message, Stay
   *  - "One message": only the next main-thread turn goes to the other model; the session stays put, so
   *    the warm cache survives for every turn after it
   *  - subagents and headless switches (source 'sdk') are never questioned
   */
  on('classic.PreModelSwitch', async ($, e, next) => {
    if (!modelGuard || e.agent_id || e.source === 'sdk' || !e.to_model || e.to_model === e.from_model) return next(e)
    const used = Number(e.context_tokens) || 0
    const from = modelName(e.from_model), to = modelName(e.to_model)
    const toast = (text) => { try { $.ui.toast(text, { timeoutMs: 6000 }) } catch { /* no UI */ } }
    if (!e.prompt_cache_warm) {
      toast(`token-saver: switching to ${to} is free right now. The cache is cold, so the next message re-reads ${fmt(used)} tokens either way.`)
      return next(e)
    }
    if (used < SWITCH_CHEAP) {
      toast(`token-saver: switching to ${to} is cheap: ${fmt(used)} tokens re-read once.`)
      return next(e)
    }
    const { priced, tokPerPct } = await billing($)
    const usd = Number(e.estimated_cache_write_usd) || 0
    const basis = e.pricing === 'catalog' ? `${to}'s list price` : e.pricing === 'configured' ? 'your configured price' : 'the default tier'
    const pct = tokPerPct > 0 ? Math.max(1, Math.round((used * 1.25) / tokPerPct)) : 0
    const cost = priced && usd > 0 ? `≈ $${usd.toFixed(2)} at ${basis}` : pct ? `≈ ${pct}% of your 5-hour window` : ''
    const question =
      `Switching to ${to} re-caches ${fmt(used)} tokens at 1.25× the input price${cost ? `, ${cost}` : ''}. ` +
      `One message sends only the next reply to ${to} and keeps ${from}'s cache warm. ` +
      `Or stay, finish this task here, then /clear and start on ${to}.`
    let choice = 'Stay'
    try { choice = await askUser($, question, ['Switch', 'One message', 'Stay'], 'Model') } catch { choice = 'Stay' }
    const redraw = () => { try { $.ui.invalidate('ui.render') } catch { /* no UI */ } }
    if (/^switch/i.test(choice)) {
      totals.switchPaid += used
      redraw()
      return next(e)
    }
    if (/^one/i.test(choice)) {
      oneShot = { model: e.to_model }
      totals.oneShot += 1
      try { $.ui.status(`Next message on ${to}, then back to ${from}`) } catch { /* no UI */ }
      redraw()
      return { permissionDecision: 'deny', permissionDecisionReason: `token-saver: the next message goes to ${to}; the session stays on ${from} so its cache stays warm` }
    }
    totals.switchHeld += used
    redraw()
    return { permissionDecision: 'deny', permissionDecisionReason: `token-saver: stayed on ${from}. Switching would re-cache ${fmt(used)} tokens${cost ? ` (${cost})` : ''}` }
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
        dim(`active ${active.length} ≈${d.per_turn_tokens} tokens every turn · parked ${parked.length} ≈${d.parked_tokens} kept out  `),
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
          dim(`  ${String(sk.per_turn).padStart(4)} tokens  `),
          ...(narrow ? [] : [dim(pad(usage[sk.name] ? `${daysAgo(usage[sk.name].last)} ×${usage[sk.name].count}` : 'never', 14))]),
          h(Button, { key: `park:${sk.name}`, label: 'Park', onPress: () => actSkills($, 'park', [sk.name], cwd) }),
        ]))
      : [dim('  no active skills')]

    const parkedRows = parked.length
      ? parked.map((sk) => row([
          dim(usage[sk.name] ? '! ' : '  '),
          text(pad(sk.name, nameW)),
          dim(`  ${String(sk.per_turn).padStart(4)} tokens  `),
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

  on('ui.close', ($, e, next) => {
    if (e && e.id === CONTEXT_PANE) { ctxPaneOpen = false; ctxPopped = false }
    return next(e)
  })

  /**
   * The Context pane (M4). Closed: title, context bar, cache and saved, Clear / Compact / Later. Open: Saved with its
   * receipt, three cards, Claude's working memory, drill-down groups. Svg cells on the desktop, Raster half-blocks on
   * the terminal; every frame a function of the 70 ms tick. Figures from loadContext(), cached 10 s.
   */
  on('ui.render', { component: 'Pane', requestId: CONTEXT_PANE }, async ($, e) => renderContext($, e, false))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props && e.props.hasSurvey) return next(e)
    bandSurface = e.surface
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
    if (showTokens && e.surface !== 'terminal') {
      // desktop: M4's closed frame (title, bar, cache · saved with Clear / Compact / Later); More opens it in place
      children.push(await renderContext($, e, true))
      return h(Box, { flexDirection: 'column' }, ...children)
    }
    if (showTokens) {
      try {
        // the terminal: M4's closed pane in one row: a short fire bar, the percent, the cache cells and words, what was saved, Open ×
        const term = true
        const pal = THEME_HEX[term ? 'terminal' : 'desktop']
        const el = $.ui.resolve(e)
        const ui = { Box, Text, Button, Svg: term ? undefined : el.Svg, Raster: term ? el.Raster : undefined, term, hex: (k) => (String(k).startsWith('#') ? k : pal[k] || pal.inactive) }
        const now = await $.clock.now()
        const clock = cacheClock(now, ttl)
        const view = contextView(await bandUsage($, now), ttl, lastUsage, clock, { rewrites, savedChars, vetoes, totals, rate: inputPricePerM, limitBase, month: monthSaved, keepWarm, agents: { types: agentTypes, weeks: agentWeeks } })
        view.compactPct = null                                   // no breakdown here: marks only
        const c = view.cache
        const t = (str, color) => h(Text, color ? { color:term ? color : ui.hex(color) } : null, term ? str : nbsp(str))
        const pctText = view.window ? `${view.pct}%` : fmtK(view.used)
        const buttons = [
          h(Button, { key: 'band-open', label: 'Open', plain: true, onPress: () => openContextPane($) }), t(' '),
          h(Button, { key: 'hide', label: '×', role: 'dismiss', plain: true, onPress: () => { bandHidden = true; invalidate($) } }),
        ]
        const row = []
        {
          // ▬ 48%  ▪▪▪▪▪ Warm 47m · Reuses 96k · 2.2M saved      Open ×   — drop "Reuses" first, then the bar, when narrow
          const words = !c.known ? 'No response yet' : !c.warm ? 'Cold' : c.cooling ? `Cooling ${c.leftMin}m` : `Warm ${c.leftMin}m`
          const reuse = !c.known ? '' : c.warm ? `Reuses ${c.amount}` : `Re-caches ${c.amount}`
          const BAR = 16
          const fixed = 1 + pctText.length + 2 + 5 + 1 + words.length + 3 + view.savings.short.length + 1 + 6
          const room = Math.max(20, width - 2)
          const withReuse = reuse && fixed + BAR + 3 + reuse.length <= room
          const withBar = fixed + BAR <= room
          if (withBar) row.push(contextBar(ui, geoOf(true, BAR, 14, 4), view, progressTick * TICK_S, clock.known))
          row.push(t(`${withBar ? ' ' : ''}${pctText}`, view.accent), t('  '), ...cacheMini(ui, c), t(' '), t(words, 'inactive'))
          if (withReuse) row.push(t(' · ', 'inactive'), t(reuse, 'inactive'))
        }
        row.push(t(' · ', 'inactive'), t(view.savings.short, 'inactive'), h(Box, { flexGrow: 1 }), t(' '), ...buttons)
        children.push(h(Box, { flexDirection: 'row', alignItems: 'center' }, ...row.filter(Boolean)))
        if (compactHint) {
          const hint = bandHint(view.pct, clock)
          if (hint) children.push(h(Text, { color: term ? 'inactive' : ui.hex('inactive'), wrap: 'truncate' }, hint))
        }
      } catch {
        /* usage unavailable: progress rows still draw */
      }
    }
    if (children.length === 0) return next(e)
    return h(Box, { flexDirection: 'column' }, ...children)
  })
}
