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
        const msg = 'token-saver is on: cache band above the prompt · /tokens · /skills · /compact is guarded when the cache is cold'
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
        name: 'skills',
        description:
          'Skills cost tokens every turn. /skills lists them; /skills park|unpark|link|unlink <names…> (globs ok). Takes effect next session.',
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
            try { $.ui.toast(line.split('. Enable here')[0] + '. See /skills suggest', { timeoutMs: 8000 }) } catch { /* no UI */ }
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
   * /skills → scripts/skills.py inside the plugin. No shell: argv only.
   * The interactive picker needs a TTY, so it stays a terminal command.
   */
  on('command.run', { command: 'skills' }, async ($, e) => {
    const words = (e.args || '').trim().split(/\s+/).filter(Boolean)
    const verb = words[0] || 'status'
    const verbs = ['status', 'suggest', 'park', 'unpark', 'link', 'unlink']
    if (!verbs.includes(verb)) {
      return { text: `usage: /skills [suggest [topic…]|park|unpark|link|unlink <names…>]  ·  picker: python3 ${$.plugin.root}/scripts/skills.py pick` }
    }
    if (verb === 'suggest' && words.length > 1) {
      // /skills suggest gsap scroll animation  →  suggest --for "gsap scroll animation"
      words.splice(1, words.length - 1, '--for', words.slice(1).join(' '))
    }
    if (!['status', 'suggest'].includes(verb) && words.length < 2) {
      return { text: `/skills ${verb} needs at least one name. Globs (gsap-*), groups (@gsap) and 'unused' work.` }
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

  if (cacheBand) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      if (!lastUsage || bandHidden) return next(e)
      if (e.props && e.props.hasSurvey) return next(e)
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
        const { Box, Text, Button } = $.ui.resolve(e)
        return h(
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
        )
      } catch {
        return next(e)
      }
    })
  }
}
