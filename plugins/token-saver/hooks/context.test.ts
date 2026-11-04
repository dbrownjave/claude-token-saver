import { test, expect, mock } from 'claude-code/testing'
import { compactNow } from './register.js'

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)
const MIN = 60_000
const PANE = { title: 'Context', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const PANE80 = { ...PANE, bodyColumns: 78 }
// the recommended action: `primary` on the desktop, a plain Button holding orange Text on the terminal (no bold, no blue)
const lit = (b: any) => b?.props?.variant === 'primary' || b?.children?.[0]?.props?.color === 'claude'
const OPTIONS = { suggestSkills: false, cacheBand: false }
// Mounting the pane draws several animated bars; give the tests room on a loaded machine.
const SLOW = 30_000

const BREAKDOWN = {
  categories: [
    { name: 'System prompt', tokens: 8_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'System tools', tokens: 3_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 63_000, color: 'permission', isDeferred: false, kind: 'used' },
    { name: 'Memory files', tokens: 20_000, color: 'success', isDeferred: false, kind: 'used' },
    { name: 'Skills', tokens: 88_000, color: 'success', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 302_000, color: 'warning', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 486_000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 30_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
    { name: 'MCP tools (deferred)', tokens: 165_300, color: 'inactive', isDeferred: true, kind: 'deferred' },
  ],
  totalTokens: 484_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'auto', percentage: 48,
  gridRows: [], model: 'Fable 5.1',
  memoryFiles: [
    { path: '/nonexistent-home/.claude/rules/token-budget.md', type: 'User', tokens: 844 },
    { path: '/repo/.claude/rules/token-budget.md', type: 'Project', tokens: 844 },
    { path: '/nonexistent-home/.claude/CLAUDE.md', type: 'User', tokens: 31 },
  ],
  mcpTools: [
    { name: 'mcp__chrome__navigate', serverName: 'claude-in-chrome', tokens: 9_400, isLoaded: true },
    { name: 'mcp__chrome__click', serverName: 'claude-in-chrome', tokens: 2_000, isLoaded: true },
    { name: 'mcp__linear__create_issue', serverName: 'linear', tokens: 5_000, isLoaded: false },
  ],
  agents: [{ agentType: 'gemini-agent', source: 'plugin', tokens: 353 }],
  skills: { totalSkills: 2, includedSkills: 2, tokens: 840, skillFrontmatter: [
    { name: 'dataviz', source: 'built-in', tokens: 480 }, { name: 'docx', source: 'plugin', pluginName: 'anthropic-skills', tokens: 360 },
  ] },
  autoCompactThreshold: 970_000, isAutoCompactEnabled: true, apiUsage: null,
}

const USAGE = {
  startedAt: NOW - 2 * 3600 * 1000,
  context: { tokens: 484_000, window: 1_000_000, percent: 48, breakdown: BREAKDOWN },
  rateLimits: [],
  cost: { usd: 1.37 },
}

const STEP = { input_tokens: 2_000, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 1_000, output_tokens: 400 }
// The same step with its write split by TTL bucket, as the API reports it
const STEP_TTL = (ttl: '5m' | '1h') => ({ ...STEP, cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? 1_000 : 0, ephemeral_1h_input_tokens: ttl === '1h' ? 1_000 : 0 } })

function wire(on: any, usage: () => any, log: { usageArgs: any[], closed: string[], compacts: any[], commands: any[] }, step: any = STEP) {
  on('session.usage' as any, (_$: any, e: any) => { log.usageArgs.push(e); return { value: usage() } })
  on('ui.close' as any, (_$: any, e: any) => { log.closed.push(e.id); return { value: undefined } })
  on('session.compact' as any, (_$: any, e: any) => { log.compacts.push(e); return { messages: [{ role: 'assistant', text: 'summary', toolUses: [] }], tokensBefore: 484_000, tokensAfter: 120_000 } })
  on('command.run' as any, (_$: any, e: any) => { log.commands.push(e); return { text: 'ran' } })
  on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete' as any, () => ({ text: 'ok' }))
  on('turn.step' as any, async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: step }
  })
  for (const ev of ['ui.toast', 'ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))
}

function setup(on: any, usage: () => any, step: any = STEP) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const log = { usageArgs: [] as any[], closed: [] as string[], compacts: [] as any[], commands: [] as any[] }
  wire(on, usage, log, step)
  return { clock, log }
}

/** One whole turn as the engine runs it: start, one main-thread step, complete. */
async function turn($: any, between?: () => void) {
  await $.turn.start({ text: 'hi', turnId: 't' })
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
  for await (const _ of s) { /* drain */ }
  await s.result
  if (between) between()
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'ok', text: 'ok' })
}

const mount = ($: any, surface: 'terminal' | 'desktop', props: any = PANE) =>
  $.ui.mount({ plugin: 'token-saver', surface, component: 'Pane', requestId: 'context', props })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`context pane on ${surface}: title figures, fire bar, cache and saved, Clear / Compact / Later without hotkeys`, { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
    const { log } = setup(on, () => USAGE)
    const ui: any = await mount($, surface)

    expect(log.usageArgs.length).toBeGreaterThan(0)
    expect(log.usageArgs[0].breakdown).toBe('summary')          // never 'full'
    expect(await ui.find({ text: /Context window/ })).toBeUndefined()
    expect(await ui.find({ text: /^Context$/ })).toBeDefined()
    expect(await ui.find({ text: /^484k \/ 1M \(48%\)$/ })).toBeDefined()   // one grey piece, as the app's Context window card
    expect(await ui.find({ text: /^[ \u00a0]\(48%\)$/ })).toBeUndefined()
    expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('More')
    expect(await ui.find({ text: /^0 saved$/ })).toBeDefined()
    expect(await ui.find({ text: /No response yet: the cache clock starts after the first reply/ })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ text: /^Cache after 1st reply$/ })).toBeDefined()
      expect(await ui.find({ type: 'Raster', key: 'ctx-bar' })).toBeDefined()
    } else {
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length).toBeGreaterThanOrEqual(2)          // the cache cells and the context bar
      expect(svgs.some((s: any) => /Context 48%/.test(String(s.props.alt)))).toBe(true)
      const ctxBar: any = svgs.find((s: any) => /Context 48%/.test(String(s.props.alt)))
      expect(String(ctxBar.props.source)).toContain('fill="#353533"')       // the design's track, not the near-black one
    }
    expect(await ui.find({ text: /Claude's working memory/ })).toBeUndefined()   // closed: nothing between the bar and the bottom row

    const clear = await ui.find({ key: 'ctx-clear' }), compact = await ui.find({ key: 'ctx-compact' }), later = await ui.find({ key: 'ctx-later' })
    for (const b of [clear, compact, later]) expect(b?.props.hotkey).toBeUndefined()
    expect(lit(later)).toBe(true)                 // before the first reply, Later is the only action
    expect(lit(compact)).toBe(false)
    expect(compact?.props.dimColor).toBe(true)
    expect(later?.props.role).toBe('dismiss')

    await ui.press({ key: 'ctx-expand' })
    expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('Less')
    expect(await ui.find({ text: /^Claude's working memory$/ })).toBeDefined()
    if (surface === 'desktop') {
      // the open pane's inner bars get 5 px of air above and below (Saved and cards 10 px tall, memory 14 px)
      const svgs = await ui.findAll({ type: 'Svg' })
      const saved = svgs.find((x: any) => /^Saved/.test(String(x.props.alt))), mem = svgs.find((x: any) => /working memory by kind/.test(String(x.props.alt)))
      expect(saved?.props.height).toBe(10 + 2 * 5)
      expect(mem?.props.height).toBe(14 + 2 * 5)
    }
    expect(await ui.find({ text: /^484k of 1M tokens$/ })).toBeDefined()
    expect(await ui.find({ text: /^Re-read every time Claude replies or uses a tool$/ })).toBeDefined()
    expect(await ui.find({ text: /^MCP tools \(deferred\)$/ })).toBeDefined()
    expect(await ui.find({ text: /^—$/ })).toBeDefined()
    expect(await ui.find({ text: /^30\.2%$/ })).toBeDefined()    // Messages 302k of 1M
    expect(await ui.find({ text: /^Saved$/ })).toBeDefined()
    expect(await ui.find({ text: /^0 tokens$/ })).toBeDefined()
    expect(await ui.find({ text: /^Cut 0% of cost$/ })).toBeDefined()
    expect(await ui.find({ text: /^Spent \$1\.37$/ })).toBeDefined()   // a cost ledger, but no turns yet: no derived rate
    expect(await ui.find({ text: /^Fresh start$/ })).toBeDefined()    // the next mark: 60% fresh start
    expect(await ui.find({ text: /^40% of the way$/ })).toBeDefined() // 48% is 40% of the way from 40 to 60
    expect(await ui.find({ text: /^Then summary while warm, then Clear$/ })).toBeDefined()
    expect(await ui.find({ text: /^Keep-warm$/ })).toBeDefined()
    expect(await ui.find({ text: /^Pings 0 of 5$/ })).toBeDefined()
    expect(await ui.find({ text: /^The clock starts after the first reply$/ })).toBeDefined()
    expect(await ui.find({ text: /turn/i })).toBeUndefined()          // never the word "turn"

    expect(await ui.find({ text: /^Total saved$/ })).toBeUndefined()
    await ui.press({ key: 'ctx-receipt' })
    expect(await ui.find({ text: /^Total saved$/ })).toBeDefined()
    expect(await ui.find({ text: /Set \$\/M in \/config for dollars/ })).toBeDefined()
    await ui.press({ key: 'ctx-receipt' })
    expect(await ui.find({ text: /^Total saved$/ })).toBeUndefined()

    expect(await ui.find({ text: /Loaded twice/ })).toBeUndefined()
    await ui.press({ key: 'ctx-group:memory' })
    expect(await ui.find({ text: /^Project · Loaded twice$/ })).toBeDefined()
    expect(await ui.find({ text: /^−844 each time$/ })).toBeDefined()
    await ui.press({ key: 'ctx-group:mcp' })
    expect(await ui.find({ text: /^claude-in-chrome$/ })).toBeDefined()
    expect(await ui.find({ text: /^1 deferred server$/ })).toBeDefined()
    expect(await ui.find({ text: /^Up to −11.4k each time$/ })).toBeDefined()
    await ui.press({ key: 'ctx-group:skills' })
    expect(await ui.find({ text: /^anthropic-skills$/ })).toBeDefined()
    await ui.press({ key: 'ctx-run:mcp' })
    expect(log.commands.map((c) => c.command)).toContain('mcp')
    expect(log.closed).toContain('context')

    await ui.press({ key: 'ctx-compact' })
    expect(log.compacts.length).toBe(1)                          // no reply yet: nothing to veto
    await ui.press({ key: 'ctx-clear' })
    expect(log.commands.map((c) => c.command)).toContain('clear')
    const closes = log.closed.length
    await ui.press({ key: 'ctx-later' })
    expect(log.closed.length).toBe(closes + 1)
  })

  test(`context pane on ${surface}: warm and cold cache sentences, and the recommended action follows them`, { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
    const usage: any = { ...USAGE, context: { ...USAGE.context, tokens: 800_000, percent: 80, breakdown: { ...BREAKDOWN, totalTokens: 800_000, percentage: 80 } } }
    const { clock, log } = setup(on, () => usage)
    await turn($)

    let ui: any = await mount($, surface)
    expect(await ui.find({ text: /^Cache (very warm|warm|chill): next message reuses[ \u00a0]$/ })).toBeDefined()
    expect(await ui.find({ text: /^800k$/ })).toBeDefined()
    expect(await ui.find({ text: /[ \u00a0]· 5m left$/ })).toBeDefined()
    expect(lit(await ui.find({ key: 'ctx-compact' }))).toBe(true)   // past compact, cache warm
    expect(lit(await ui.find({ key: 'ctx-clear' }))).toBe(false)
    if (surface === 'terminal') expect(await ui.find({ text: /^Very warm 5m$/ })).toBeDefined()
    await ui.press({ key: 'ctx-expand' })
    expect(await ui.find({ text: /^Compact$/ })).toBeDefined()
    expect(await ui.find({ text: /^Now$/ })).toBeDefined()
    expect(await ui.find({ text: /^Very warm$/ })).toBeDefined()
    expect(await ui.find({ text: /^Warmth 100%$/ })).toBeDefined()

    await clock.advance(10 * MIN)
    await ui.unmount()
    ui = await mount($, surface)
    expect(await ui.find({ text: /^Cache frozen: next message re-caches[ \u00a0]$/ })).toBeDefined()
    const compact = await ui.find({ key: 'ctx-compact' })
    expect(lit(compact)).toBe(false)                // cold: Compact would re-cache everything
    expect(compact?.props.dimColor).toBe(true)
    expect(lit(await ui.find({ key: 'ctx-clear' }))).toBe(true)
    expect(await ui.find({ text: /^Clear$/, type: 'Text' })).toBeDefined()           // the next-mark card says Clear · Now
    expect(await ui.find({ text: /^Compact would re-cache 800k$/ })).toBeDefined()
    expect(await ui.find({ text: /^Idle 10m, past 5m$/ })).toBeDefined()

    await ui.press({ key: 'ctx-compact' })
    expect(log.compacts.length).toBe(0)                           // the guard vetoes a cold compact
    expect(await ui.find({ text: /^Compact vetoed: the prompt cache has lapsed/ })).toBeDefined()
  })
}

/** A host whose $.session.compact rejects as the desktop's does; the harness cannot carry that message through a hook. */
function noCompactHost(fill: any = { isFilled: true }) {
  const log = { commands: [] as any[], submits: [] as any[], fills: [] as any[], toasts: [] as string[] }
  const $: any = {
    clock: { now: async () => NOW },
    session: { compact: async () => { throw new Error('session.compact: not available on this host') } },
    command: { run: async (e: any) => { log.commands.push(e) } },
    prompt: { submit: async (e: any) => { log.submits.push(e) }, fill: async (e: any) => { log.fills.push(e); return fill } },
    ui: { toast: (t: string) => { log.toasts.push(t) }, invalidate: () => {} },
  }
  return { $, log }
}

test('Compact where session.compact is not available runs the compact command, never a / prompt', async () => {
  const { $, log } = noCompactHost()
  await compactNow($, 5 * MIN, false)
  expect(log.commands).toEqual([{ command: 'compact', args: '' }])
  expect(log.submits).toEqual([])
  expect(log.toasts.some((t) => /\/compact sent/.test(t))).toBe(true)
})

test('Compact from inside a command.run hook drafts /compact in the box and says to press Enter', async () => {
  const { $, log } = noCompactHost()
  await compactNow($, 5 * MIN, false, { inCommandHook: true })
  expect(log.commands).toEqual([])
  expect(log.fills).toEqual([{ text: '/compact' }])
  expect(log.toasts.some((t) => /press Enter/.test(t))).toBe(true)
})

test('Compact while a turn runs waits for it instead of showing the engine error; a second press cancels', async () => {
  const { $, log } = noCompactHost()
  const compacts: any[] = []
  $.session = {
    usage: async () => USAGE,
    compact: async (e: any) => { compacts.push(e); throw new Error('$.session.compact: a turn is running (sess_01JD8Z4Q7XK2)') },
  }
  await compactNow($, 5 * MIN, false)
  expect(compacts.length).toBe(1)
  expect(log.commands).toEqual([])                                 // no /compact into a running turn either
  expect(log.toasts.at(-1)).toBe('token-saver: compact queued: it runs when Claude finishes this reply (484k tokens now)')
  for (const t of log.toasts) expect(t).not.toMatch(/session\.compact|sess_|turn is running|\btok\b/)
  await compactNow($, 5 * MIN, false)                              // pressed again: cancelled, the engine is not asked
  expect(compacts.length).toBe(1)
  expect(log.toasts.at(-1)).toBe('token-saver: compact cancelled: no tokens freed')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`Compact pressed mid-turn on ${surface} reads Queued and runs at turn.complete`, { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
    const { log } = setup(on, () => USAGE)
    await turn($)                                                  // a warm cache, so the guard lets it through
    await ($ as any).turn.start({ text: 'long one', turnId: 't2' })
    const ui: any = await mount($, surface)
    await ui.press({ key: 'ctx-compact' })
    expect(log.compacts.length).toBe(0)
    expect(log.commands).toEqual([])
    expect((await ui.find({ key: 'ctx-compact' }))?.props.label).toBe('Queued')
    expect(await ui.find({ text: /^Compact[ \u00a0]queued:[ \u00a0]it[ \u00a0]runs[ \u00a0]when[ \u00a0]Claude[ \u00a0]finishes[ \u00a0]this[ \u00a0]reply[ \u00a0]\(484k[ \u00a0]tokens[ \u00a0]now\)$/ })).toBeDefined()
    expect(await ui.find({ text: /session\.compact|\btok\b/ })).toBeUndefined()

    await ($ as any).turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', text: 'ok' })
    for (let i = 0; i < 50 && !log.compacts.length; i++) await new Promise((r) => setTimeout(r, 10))
    expect(log.compacts.length).toBe(1)
    for (let i = 0; i < 50 && (await ui.find({ key: 'ctx-compact' }))?.props.label !== 'Compact'; i++) await new Promise((r) => setTimeout(r, 10))
    expect((await ui.find({ key: 'ctx-compact' }))?.props.label).toBe('Compact')
    expect(await ui.find({ text: /^Compacted[ \u00a0]484k[ \u00a0]→[ \u00a0]≈271k$/ })).toBeDefined()   // 120k of summary + 151k of setup
  })
}

test('a subagent finishing mid-turn does not end the turn: Compact still queues', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { log } = setup(on, () => USAGE)
  await turn($)
  await ($ as any).turn.start({ text: 'long one', turnId: 't2' })
  await ($ as any).turn.start({ text: 'sub', turnId: 'a1', agentId: 'a1' })
  await ($ as any).turn.complete({ turnId: 'a1', agentId: 'a1', reason: 'answer', answer: 'ok', text: 'ok' })
  const ui: any = await mount($, 'terminal')
  await ui.press({ key: 'ctx-compact' })
  expect(log.compacts.length).toBe(0)
  expect((await ui.find({ key: 'ctx-compact' }))?.props.label).toBe('Queued')
})

test('a subscription caches for the hour: Compact runs ten idle minutes on, no veto', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { log, clock } = setup(on, () => ({ ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 40 }, { kind: 'seven_day', percentUsed: 10 }] }))
  await turn($)
  await clock.advance(10 * MIN)
  const ui: any = await mount($, 'terminal')
  await ui.press({ key: 'ctx-compact' })
  for (let i = 0; i < 50 && !log.compacts.length; i++) await new Promise((r) => setTimeout(r, 10))
  expect(log.compacts.length).toBe(1)
  expect(await ui.find({ text: /^Compact vetoed/ })).toBeUndefined()
})

test('context pane counts context growth per message and says how many messages to the next mark', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const ctx = { tokens: 100_000, window: 200_000, percent: 50 }
  const { clock } = setup(on, () => ({ context: { ...ctx }, rateLimits: [], cost: { usd: 0.5 } }))
  let ui: any = await mount($, 'terminal', PANE80)
  await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /^At 60%$/ })).toBeDefined()        // no growth measured yet: no message estimate
  expect(await ui.find({ text: /^[ \u00a0]· 20k to go$/ })).toBeDefined()

  await turn($, () => { ctx.tokens = 106_000; ctx.percent = 53 })
  await turn($, () => { ctx.tokens = 112_000; ctx.percent = 56 })
  await clock.advance(11_000)                                    // past the pane's 10 s figures cache
  await ui.unmount()
  ui = await mount($, 'terminal', PANE80)
  expect(await ui.find({ text: /^In ≈2 messages$/ })).toBeDefined()  // 8k to 60% at 6k a message
  expect(await ui.find({ text: /^[ \u00a0]· 8k to go$/ })).toBeDefined()
  expect(await ui.find({ text: /^80% of the way$/ })).toBeDefined()
})

test('context pane without a breakdown falls back to one Used row and no groups', { options: { ...OPTIONS, cardBars: 'ember' }, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => ({ startedAt: NOW, context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [] }))
  const ui: any = await mount($, 'desktop')
  expect(await ui.find({ text: /^120k \/ 200k \(60%\)$/ })).toBeDefined()
  await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /^Used$/ })).toBeDefined()
  expect(await ui.find({ text: /^Free space$/ })).toBeDefined()
  expect(await ui.find({ key: 'ctx-group:mcp' })).toBeUndefined()
  expect(await ui.find({ text: /^Compact$/, type: 'Text' })).toBeDefined()        // the next mark is compact at 75%
  await ui.press({ key: 'ctx-receipt' })
  expect(await ui.find({ text: /^Tokens only$/ })).toBeDefined()                   // no cost ledger, no rate limits
})

test('context pane on a subscription: the five-hour window card, and never a dollar', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => ({ startedAt: NOW, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 3600_000).toISOString() }], cost: { usd: 0.5 } }))
  const ui: any = await mount($, 'desktop')
  await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /^Current session$/ })).toBeDefined()
  expect(await ui.find({ text: /^Usage 40%$/ })).toBeDefined()
  expect(await ui.find({ text: /^[ \u00a0]· Time 80%$/ })).toBeDefined()                    // reset in 1 h of a 5 h window
  expect(await ui.find({ text: /^Resets in 1h 0m$/ })).toBeDefined()
  await ui.press({ key: 'ctx-receipt' })
  expect(await ui.find({ text: /Subscription: window maths appears once the 5-hour window moves/ })).toBeDefined()
  expect(await ui.find({ text: /\$/ })).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`context pane on ${surface}: ? explains the pane, and More opens the glossary at that term`, { options: { ...OPTIONS, inputPricePerM: 3 }, timeoutMs: SLOW }, async ($, on) => {
    setup(on, () => USAGE)
    await turn($)
    const ui: any = await mount($, surface)
    expect(await ui.find({ text: /^Explain this pane$/ })).toBeUndefined()
    await ui.press({ key: 'ctx-explain' })
    expect(await ui.find({ text: /^Explain this pane$/ })).toBeDefined()
    expect(await ui.find({ text: /^Live values, this session$/ })).toBeDefined()
    const one = surface === 'terminal' ? /^¹[ \u00a0]$/ : /^①[ \u00a0]$/, five = surface === 'terminal' ? /^⁵[ \u00a0]$/ : /^⑤[ \u00a0]$/
    expect(await ui.find({ text: one })).toBeDefined()
    expect(await ui.find({ text: five })).toBeDefined()
    expect(await ui.find({ text: /Warm, 5m left: your next message reuses 484k \(≈ \$0\.07 instead of \$1\.81\)\./ })).toBeDefined()
    expect(await ui.find({ text: /Recommended now: Later\./ })).toBeDefined()
    expect(await ui.find({ key: 'ctx-more:cache' })).toBeDefined()
    expect(await ui.find({ text: /undefined|NaN/ })).toBeUndefined()

    await ui.press({ key: 'ctx-expand' })                         // open: markers 6 to 9 and their entries
    expect(await ui.find({ text: /^What is inside each kind, with a button to trim it$/ })).toBeDefined()
    expect(await ui.find({ text: /^Groups$/ })).toBeDefined()

    await ui.press({ key: 'ctx-more:cache' })
    expect(await ui.find({ text: /^Glossary$/, type: 'Text' })).toBeDefined()
    expect(await ui.find({ text: /^Explain this pane$/ })).toBeUndefined()
    const focused = await ui.find({ text: /^Prompt cache$/ })
    expect(focused?.props.color).toBe(surface === 'terminal' ? 'claude' : '#d97757')   // desktop gets the app's own colour value
    expect(await ui.find({ text: /^▸[ \u00a0]$/ })).toBeDefined()
    expect(await ui.find({ text: /^Basics$/ })).toBeDefined()
    expect(await ui.find({ text: /undefined|NaN/ })).toBeUndefined()
    await ui.press({ key: 'ctx-glossary-back' })
    expect(await ui.find({ text: /^Explain this pane$/ })).toBeDefined()
    await ui.press({ key: 'ctx-explain' })
    expect(await ui.find({ text: /^Explain this pane$/ })).toBeUndefined()
  })
}

test('/tokens learn prints the glossary; a term prints just that term with its live value', { options: { ...OPTIONS, inputPricePerM: 3 }, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  await turn($)
  const all = String((await ($ as any).command.run({ command: 'tokens', args: 'learn' })).text)
  expect(all).toContain('Basics')
  expect(all).toContain('Savings')
  expect(all).not.toMatch(/undefined|NaN/)
  const cache = String((await ($ as any).command.run({ command: 'tokens', args: 'learn cache' })).text)
  expect(cache).toContain('Prompt cache')
  expect(cache).toContain('Warm, 5m left: your next message reuses 484k')
  expect(cache).not.toContain('Hit rate')
  const none = String((await ($ as any).command.run({ command: 'tokens', args: 'learn zebra' })).text)
  expect(none).toContain('No term matches')
  expect(none).toContain('Prompt cache')
})

test('the glossary on a subscription never shows a dollar', { options: { ...OPTIONS, inputPricePerM: 3 }, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => ({ ...USAGE, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 3600_000).toISOString() }] }))
  await turn($)
  const all = String((await ($ as any).command.run({ command: 'tokens', args: 'learn' })).text)
  expect(all).not.toContain('$')
  expect(all).toContain('40% used, resets in 1h 0m.')
  const ui: any = await mount($, 'desktop')
  await ui.press({ key: 'ctx-explain' })
  await ui.press({ key: 'ctx-glossary' })
  expect(await ui.find({ text: /^Glossary$/, type: 'Text' })).toBeDefined()
  expect(await ui.find({ text: /\$/ })).toBeUndefined()
})

for (const [surface, cols] of [['mobile', 44], ['desktop', 60]] as const) {
  test(`context pane narrow on ${surface} (${cols} cols): no ⤢, Saved splits in two, cards one per row`, { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
    setup(on, () => USAGE)
    const ui: any = await mount($, surface as any, { ...PANE, bodyColumns: cols })
    if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
    expect(await ui.find({ key: 'ctx-popout' })).toBeUndefined()
    expect(await ui.find({ text: /^Cut 0% of cost$/ })).toBeDefined()
    expect(await ui.find({ text: /^ this session$/ })).toBeDefined()      // its own line, no trailing " · "
    expect(await ui.find({ key: 'ctx-receipt' })).toBeDefined()
    // no fixed-width card columns: each card grows to the body's width
    const fixed = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props.width === Math.max(16, Math.floor((cols - 1 - 6) / 3)))
    expect(fixed.length).toBe(0)
    expect(await ui.find({ key: 'ctx-clear' })).toBeDefined()
  })
}



for (const surface of ['terminal', 'desktop'] as const) {
  test(`true numbers on ${surface}: Claude's own cache reads are shown, never counted as saved`, { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
    setup(on, () => USAGE)
    await turn($)                                                     // one step: 150k cache reads, nothing the plugin did
    const ui: any = await mount($, surface)
    if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
    expect(await ui.find({ text: /^0 tokens$/ })).toBeDefined()           // Saved: zero, the plugin did nothing yet
    expect(await ui.find({ text: /^Cut 0% of cost$/ })).toBeDefined()
    expect(await ui.find({ text: /Prompt cache read 150k tokens at a fraction of the price/ })).toBeDefined()
    expect(await ui.find({ text: /^Cache reads/ })).toBeUndefined()    // the old, false source is gone
    await ui.press({ key: 'ctx-receipt' })
    expect(await ui.find({ text: /^Prompt cache, Claude's own \(not counted\)$/ })).toBeDefined()
    expect(await ui.find({ text: /^Trimmed output$/ })).toBeDefined()
    expect(await ui.find({ text: /^Compactions vetoed$/ })).toBeDefined()
    expect(await ui.find({ text: /^Keep-warm$/ })).toBeDefined()
  })
}

test('desktop: a redraw with the same figures gives the same Svg sources, so a scroll does not reload the bars', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE)
  const srcs = async (offset: number) => {
    const ui: any = await mount($, 'desktop', { ...PANE, scroll: { offset, bodyRows: 40 } })
    if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })   // open stays open
    const out = (await ui.findAll({ type: 'Svg' })).map((s: any) => [String(s.props.alt), String(s.props.source)])
    await ui.unmount()
    return out
  }
  const a = await srcs(0)
  await clock.advance(700)                                     // ten ticks of the band's clock between the two drawings
  const b = await srcs(3)
  expect(b.length).toBe(a.length)
  for (let i = 0; i < a.length; i++) {
    expect(b[i][0]).toBe(a[i][0])
    expect(b[i][1] === a[i][1]).toBe(true)                      // byte for byte: the animated ones included
  }
  expect(a.some(([, src]) => src.includes('<animate'))).toBe(true)
})

test('/clear says what it freed, typed or from the pane, and the band starts over', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  let cleared = false
  const toasts: string[] = []
  const lines: string[] = []
  // wire() minus the toast and log sinks: this test reads them. Before the clear the engine reports the full
  // window; after it, only the next session's preamble.
  on('session.usage' as any, () => ({ value: cleared ? { ...USAGE, context: { tokens: 12_000, window: 1_000_000, percent: 1 } } : USAGE }))
  on('command.run' as any, (_$: any, e: any) => { if (e.command === 'clear') cleared = true; return { text: 'ran' } })
  on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete' as any, () => ({ text: 'ok' }))
  on('turn.step' as any, async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: STEP }
  })
  on('ui.status' as any, () => ({ value: undefined }))
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(JSON.stringify(e)); return { value: undefined } })
  on('ui.log' as any, (_$: any, e: any) => { lines.push(JSON.stringify(e)); return { value: undefined } })
  await turn($)
  await ($ as any).command.run({ command: 'clear', args: '' })
  expect(cleared).toBe(true)
  // the breakdown just before the clear: Messages 302k is what goes; MCP tools, skills, prompt, tools and memory (182k) load again
  expect(toasts.some((t) => /Cleared ≈302k tokens of conversation \(30% of 1M\)/.test(t))).toBe(true)
  expect(lines.some((t) => /≈302k tokens of conversation/.test(t))).toBe(true)
  expect(toasts.some((t) => /The next message re-reads ≈182k of setup \(system prompt, tools, memory\)/.test(t))).toBe(true)   // not freed: read again
})

test('/tokens list is the pane as a table: context with a bar, cache, saved, keep-warm, memory, next, then help', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  await turn($)
  const text = String((await ($ as any).command.run({ command: 'tokens', args: 'list', presentation: { columns: 120 } })).text)
  const lines = text.split('\n')
  expect(lines[0]).toMatch(/^┌─+┬─+┬─+┐$/)
  expect(lines[1]).toMatch(/^│ Context +│ 484k of 1M \(48%\) +│ █{10}░{10} +│$/)
  expect(lines[2]).toMatch(/^│ Cache +│ Very warm \d+m +│ next message reuses 484k from cache · \d+m left · hit \d+% +│$/)
  expect(lines[3]).toMatch(/^│ Saved +│ 0 tokens +│ trimmed output 0 · compactions vetoed 0 · keep-warm 0 +│$/)
  expect(lines[4]).toMatch(/^│ Keep-warm +│ (on|off[^│]*) +│/)
  expect(lines[5]).toMatch(/^│ Idle +│ \S[^│]* +│ compaction: /)
  expect(lines[6]).toMatch(/^│ Memory +│ messages 302k +│ skills 88k · MCP tools 63k · memory files 20k · system prompt 8k +│$/)
  expect(lines[7]).toMatch(/^│ Next +│ \S/)
  expect(lines[8]).toMatch(/^└─+┴─+┴─+┘$/)
  expect(lines[9]).toMatch(/^\/tokens opens the pane · \/tokens learn/)
  const widths = new Set(lines.slice(0, 9).map((l) => [...l].length))
  expect(widths.size).toBe(1)                                        // every row is as wide as the frame
  expect(text).not.toMatch(/\btok\b/)
})

test('Claude Code idle compaction is named in the pane, gets the keep-list, and is never counted as saved', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock, log } = setup(on, () => USAGE)
  await turn($)
  await clock.advance(54 * 60_000)                          // 90% of the one-hour TTL, as Claude Code fires it
  const r: any = await ($ as any).session.compact({ trigger: 'auto', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  expect(r.skip).toBeUndefined()
  expect(String(log.compacts[0].instructions)).toContain('When compacting, keep')
  const ui: any = await mount($, 'terminal')
  expect(await ui.find({ text: /Claude compacted while idle \(54m\): 484k → ≈271k tokens\. Claude Code's own feature, not counted in Saved\./ })).toBeDefined()
  expect(await ui.find({ text: /^0 saved$/ })).toBeDefined()
})

test('an auto-compaction right after a reply is not called idle', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE)
  await turn($)
  await clock.advance(5_000)
  await ($ as any).session.compact({ trigger: 'auto', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  const ui: any = await mount($, 'terminal')
  expect(await ui.find({ text: /compacted while idle/ })).toBeUndefined()
})

test('the cache clock follows the engine\'s one-hour TTL: warm after 10 minutes, and /compact goes through', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock, log } = setup(on, () => USAGE, STEP_TTL('1h'))
  await turn($)
  await clock.advance(10 * MIN)
  const ui: any = await mount($, 'terminal')
  expect(await ui.find({ text: /[ \u00a0]· 50m left$/ })).toBeDefined()
  const r: any = await ($ as any).session.compact({ trigger: 'manual', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  expect(r.skip).toBeUndefined()
  expect(log.compacts.length).toBe(1)
})

test('on the engine\'s 5-minute TTL the same 10 minutes is cold, and /compact is vetoed', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock, log } = setup(on, () => USAGE, STEP_TTL('5m'))
  await turn($)
  await clock.advance(10 * MIN)
  const r: any = await ($ as any).session.compact({ trigger: 'manual', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  expect(String(r.skip)).toContain('prompt cache has lapsed')
  expect(log.compacts.length).toBe(0)
})

test('longCacheTtl overrides the engine\'s 5-minute reading', { options: { ...OPTIONS, keepWarm: false, longCacheTtl: true }, timeoutMs: SLOW }, async ($, on) => {
  const { clock, log } = setup(on, () => USAGE, STEP_TTL('5m'))
  await turn($)
  await clock.advance(10 * MIN)
  const r: any = await ($ as any).session.compact({ trigger: 'manual', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  expect(r.skip).toBeUndefined()
  expect(log.compacts.length).toBe(1)
})

test('an idle compaction means the one-hour cache: the clock runs an hour after it, without overriding a step\'s reading', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock, log } = setup(on, () => USAGE)            // steps without TTL buckets
  await turn($)
  await clock.advance(54 * MIN)
  await ($ as any).session.compact({ trigger: 'auto', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  await turn($)
  await clock.advance(10 * MIN)
  const r: any = await ($ as any).session.compact({ trigger: 'manual', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  expect(r.skip).toBeUndefined()
  expect(log.compacts.length).toBe(2)
})

const SETTINGS = (on: any, value: any) => on('settings.read' as any, () => ({ value }))
const full = async ($: any) => { const ui: any = await mount($, 'terminal'); await ui.press({ key: 'ctx-expand' }); return ui }

test('idle compaction section counts down from the last reply on the one-hour cache', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, {})
  await turn($)
  await clock.advance(16 * MIN)
  const ui: any = await full($)
  expect(await ui.find({ text: /^Idle compaction$/ })).toBeDefined()
  expect(await ui.find({ text: /^≈38m left$/ })).toBeDefined()
  expect(await ui.find({ text: /484k becomes a summary ≈54m after your last reply/ })).toBeDefined()
  expect(await ui.find({ key: 'card-idle' })).toBeDefined()
})

test('idle compaction section follows your size floor', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, { env: { CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS: '600000' } })
  await turn($)
  await clock.advance(MIN)
  const ui: any = await full($)
  expect(await ui.find({ text: /^484k of 600k$/ })).toBeDefined()
  expect(await ui.find({ text: /Runs from 600k tokens \(your setting\)/ })).toBeDefined()
})

test('idle compaction section says Off when idleCompaction is false', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, { idleCompaction: false })
  await turn($)
  await clock.advance(MIN)
  const ui: any = await full($)
  expect(await ui.find({ text: /^Off in your settings$/ })).toBeDefined()
  expect(await ui.find({ text: /"idleCompaction": false/ })).toBeDefined()
})

test('idle compaction section on the 5-minute cache says it needs the one-hour cache', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE, STEP_TTL('5m'))
  SETTINGS(on, {})
  await turn($)
  await clock.advance(MIN)
  const ui: any = await full($)
  expect(await ui.find({ text: /^Needs the one-hour cache$/ })).toBeDefined()
  expect(await ui.find({ text: /This session caches for 5 minutes/ })).toBeDefined()
})

test('idle compaction section shows the compaction once it ran, until the next reply', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, {})
  await turn($)
  await clock.advance(54 * MIN)
  await ($ as any).session.compact({ trigger: 'auto', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  const ui: any = await full($)
  expect(await ui.find({ text: /^Compacted 484k → ≈271k$/ })).toBeDefined()
  await turn($)
  await clock.advance(MIN)
  await ui.redraw()
  expect(await ui.find({ text: /^Compacted 484k → ≈271k$/ })).toBeUndefined()
  expect(await ui.find({ text: /^≈53m left$/ })).toBeDefined()
})

test('desktop pane: no box wider than the pane, bars and dividers one width, long lines wrap', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, {})
  await turn($)
  for (const cols of [36, 50, 98]) {
    const ui: any = await mount($, 'desktop', { ...PANE, bodyColumns: cols })
    if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })   // open stays open across mounts
    const root: any = await ui.drawn()
    const boxes: any[] = [], svgs: any[] = []
    const walk = (n: any) => { if (!n || typeof n !== 'object') return; if (n.type === 'Box') boxes.push(n); if (n.type === 'Svg') svgs.push(n); (n.children || []).forEach(walk) }
    walk(root)
    for (const b of boxes) if (typeof b.props?.width === 'number') expect(b.props.width).toBeLessThanOrEqual(cols)   // Box widths are cells: a px figure here pushes rows off screen
    const full = svgs.map((x) => x.props.width).filter((w) => w >= Math.max(120, (cols - 1) * 8.1) - 2)
    expect(full.length).toBeGreaterThan(3)
    expect(new Set(full).size).toBe(1)                                        // every full-width bar and divider ends on one edge
    expect(svgs.some((x) => x.props.alt === 'divider')).toBe(true)
    expect(svgs.some((x) => x.props.alt === 'card-idle')).toBe(true)
    const hint = await ui.find({ type: 'Text', text: /^Auto-compact at/ })
    expect(hint?.props.wrap).toBe('wrap')
    expect(await ui.find({ text: /─{20}/ })).toBeUndefined()
    await ui.unmount()
  }
})

for (const cols of [24, 40, 50, 120]) {
  test(`desktop pane at ${cols} columns keeps ?, More, ⤢ and Clear / Compact / Later outside the bars' width`, { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
    setup(on, () => USAGE, STEP_TTL('1h'))
    SETTINGS(on, {})
    await turn($)
    const ui: any = await mount($, 'desktop', { ...PANE, bodyColumns: cols })
    const root: any = await ui.drawn()
    expect(root.props.width).toBeUndefined()
    const inFrame = (key: string) => { let hit = false; const walk = (n: any, boxed: boolean) => { if (!n || typeof n !== 'object') return; const b = boxed || !!(n.props && n.props.width && n.type === 'Box'); if (n.props && n.props.key === key && b) hit = true; (n.children || []).forEach((c: any) => walk(c, b)) }; walk(root, false); return hit }
    for (const k of ['ctx-explain', 'ctx-expand', 'ctx-clear', 'ctx-compact', 'ctx-later']) {
      expect(await ui.find({ key: k })).toBeDefined()
      expect(inFrame(k)).toBe(false)
    }
    await ui.press({ key: 'ctx-expand' })
    expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('Less')
    if (cols >= 72 && (await ui.find({ key: 'ctx-popout' }))) expect(inFrame('ctx-popout')).toBe(false)
  })
}

test('the cache reads Very warm, Warm, Chill, Fading, then Frozen, with one square in its colour and room above the bottom row', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE, STEP_TTL('5m'))
  SETTINGS(on, {})
  await turn($)
  const seen: string[] = []
  const colors = new Set<string>()
  for (const [mins, word] of [[0.5, 'Very warm'], [1, 'Warm'], [1, 'Chill'], [1.5, 'Fading'], [2, 'Frozen']] as const) {
    await clock.advance(mins * MIN)
    const ui: any = await mount($, 'desktop', { ...PANE, bodyColumns: 50 })
    const minis = (await ui.findAll({ type: 'Svg' })).filter((x: any) => /^Cache /.test(String(x.props.alt)))
    expect(minis.length).toBe(1)                                              // one square, not five cells
    expect(minis[0].props.alt).toBe(`Cache ${word}`)
    colors.add(String(minis[0].props.source).match(/fill="([^"]+)"/)![1])
    const root: any = await ui.drawn()
    expect(root.children.some((c: any) => c && c.props && c.props.marginTop === 1)).toBe(true)
    seen.push(word)
    await ui.unmount()
  }
  expect(seen.length).toBe(5)
  expect(colors.size).toBe(5)                                                 // each word its own colour
})

test('mobile pane: one card per row, nothing wider than the screen, long lines wrap', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, {})
  await turn($)
  const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'mobile', component: 'Pane', requestId: 'context', props: { ...PANE, bodyColumns: 44 } })
  if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
  const root: any = await ui.drawn()
  const boxes: any[] = []
  const walk = (n: any) => { if (!n || typeof n !== 'object') return; if (n.type === 'Box') boxes.push(n); (n.children || []).forEach(walk) }
  walk(root)
  for (const b of boxes) if (typeof b.props?.width === 'number') expect(b.props.width).toBeLessThanOrEqual(44)
  expect((await ui.find({ type: 'Text', text: /^Auto-compact at/ }))?.props.wrap).toBe('wrap')
  expect((await ui.find({ type: 'Text', text: /^Prompt cache read/ }))?.props.wrap).toBe('wrap')
  for (const k of ['ctx-explain', 'ctx-clear', 'ctx-compact', 'ctx-later']) expect(await ui.find({ key: k })).toBeDefined()
  expect(await ui.find({ text: /^Idle compaction$/ })).toBeDefined()
})

const hintOf = async ($: any) => {
  const ui: any = await mount($, 'terminal')
  const all = await ui.findAll({ type: 'Text', text: /^(Idle compaction (in|now)|Cache (cold|frozen)|Compacted while away|Auto-compact)/ })
  await ui.unmount()
  return all.map((x: any) => String(x.text))
}
const USAGE_AT = (tokens: number, threshold: number) => ({
  ...USAGE, context: { ...USAGE.context, tokens, percent: tokens / 10_000, breakdown: { ...BREAKDOWN, totalTokens: tokens, percentage: tokens / 10_000, autoCompactThreshold: threshold } },
})

test('hint: idle compaction close says so, and beats the 1M auto-compact advice', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, {})
  await turn($)
  await clock.advance(MIN)
  expect((await hintOf($))[0]).toMatch(/^Auto-compact at 970k\. Try \/autocompact 400k\.$/)
  await clock.advance(45 * MIN)
  expect((await hintOf($))[0]).toMatch(/^Idle compaction in ≈8m\. Reply to keep full history\.$/)
})

test('hint: armed idle compaction is a quiet note when nothing else needs saying', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  // auto-compact at 800k: no mark is passed at 250k (with 400k the marks scale to 16/24/30% and 25% is past one)
  const { clock } = setup(on, () => USAGE_AT(250_000, 800_000), STEP_TTL('1h'))
  SETTINGS(on, {})
  await turn($)
  await clock.advance(MIN)
  expect((await hintOf($))[0]).toMatch(/^Idle compaction in ≈53m if you step away\.$/)
})

test('hint: the 5-minute cache goes cold, then frozen, and the line says what each costs', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE_AT(250_000, 400_000), STEP_TTL('5m'))
  SETTINGS(on, {})
  await turn($)
  await clock.advance(MIN)
  expect(await hintOf($)).toEqual([])                                          // warm, nothing to say
  await clock.advance(3 * MIN)
  expect((await hintOf($))[0]).toMatch(/^Cache cold: 1m left to reuse 250k tokens\.$/)
  await clock.advance(2 * MIN)
  expect((await hintOf($))[0]).toMatch(/^Cache frozen: next message re-reads 250k tokens\.$/)
})

test('hint: after an idle compaction it says the next message reads the summary', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, {})
  await turn($)
  await clock.advance(54 * MIN)
  await ($ as any).session.compact({ trigger: 'auto', instructions: '', messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  expect((await hintOf($))[0]).toMatch(/^Compacted while away: 484k → ≈271k tokens\.$/)
})

test('hint: auto-compact a few messages away is counted from this session\'s growth', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  let tokens = 330_000
  const { clock } = setup(on, () => USAGE_AT(tokens, 400_000), STEP_TTL('5m'))
  SETTINGS(on, {})
  for (let k = 0; k < 3; k++) {
    await turn($, () => { tokens += 20_000 })
    await clock.advance(MIN)
  }
  const h = (await hintOf($))[0]
  expect(h).toMatch(/^Auto-compact in ≈\d+ messages? \(400k\)\.$/)
})

/** Relative luminance of a #rrggbb, 0 (black) to 1 (white). */
const lum = (hex: string) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const HEXC = /^#[0-9a-f]{6}$/i
/** What the open pane paints: Text colours (bar cells and ■ swatches left out) and each bar's track. */
async function paints($: any, surface: 'terminal' | 'desktop') {
  const ui: any = await mount($, surface)
  if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ key: 'ctx-settings' })).toBeDefined()                // ⚙ opens the Settings panel
  const texts: string[] = [], tracks: string[] = []
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return
    const p = n.props || {}
    if (n.type === 'Text' && typeof p.color === 'string' && HEXC.test(p.color) && !p.backgroundColor && !/^■\s*$/.test((n.children || []).join(''))) texts.push(p.color)   // a ■ swatch is its bar's colour
    if (n.type === 'Svg') { const m = /<\/defs><rect width="[^"]+" height="[^"]+" rx="[^"]+" fill="(#[0-9a-f]{6})"/i.exec(p.source || ''); if (m) tracks.push(m[1]) }
    if (n.type === 'Raster' && p.cells && (n.key ?? p.key) !== 'card-cache') {   // card-cache is full at Warmth 100%: no bare track
      // [char, fg, bg] per cell; past the fill the bottom half is the bare track
      const b = Uint8Array.from(atob(p.cells), (ch) => ch.charCodeAt(0)), w = new Uint32Array(b.buffer)
      tracks.push('#' + w[w.length - 1].toString(16).padStart(6, '0'))
    }
    ;(n.children || []).forEach(walk)
  }
  walk(await ui.drawn())
  await ui.unmount()
  return { texts, tracks }
}

for (const surface of ['terminal', 'desktop'] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`theme ${theme} on ${surface}: text readable on its ground, bar tracks on the ${theme} side`, { options: { ...OPTIONS, keepWarm: false, theme }, timeoutMs: SLOW }, async ($, on) => {
      setup(on, () => USAGE, STEP_TTL('1h'))
      SETTINGS(on, {})
      await turn($)
      const { texts, tracks } = await paints($, surface)
      expect(tracks.length).toBeGreaterThan(3)
      if (surface === 'desktop') expect(texts.length).toBeGreaterThan(5)       // the desktop paints its Text in hex
      if (theme === 'light') {
        for (const c of texts) expect(lum(c)).toBeLessThan(0.6)               // no near-white text on a light pane
        for (const c of tracks) expect(lum(c)).toBeGreaterThan(0.5)           // no near-black track
      } else {
        for (const c of texts) expect(lum(c)).toBeGreaterThan(0.08)           // no near-black text on a dark pane
        for (const c of tracks) expect(lum(c)).toBeLessThan(0.2)
      }
    })
  }
}

test('theme auto: the terminal follows its /config Theme row and a later change; the desktop stays dark', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE, STEP_TTL('1h'))
  SETTINGS(on, {})
  on('config.list' as any, () => ({ value: [{ key: 'model', value: 'opus' }, { key: 'theme', value: 'light-daltonized' }] }))
  on('config.set' as any, (_$: any, e: any) => ({ value: e.value }))
  await turn($)
  const side = async (s: 'terminal' | 'desktop') => (await paints($, s)).tracks.map((c) => (lum(c) > 0.5 ? 'light' : lum(c) < 0.2 ? 'dark' : c))
  expect(new Set(await side('terminal'))).toEqual(new Set(['light']))
  expect(new Set(await side('desktop'))).toEqual(new Set(['dark']))
  await ($ as any).config.set({ key: 'theme', value: 'dark' })
  expect(new Set(await side('terminal'))).toEqual(new Set(['dark']))
})


// ---- 0.3.45: what a new-user review found ----

test('a trim is counted once, not again on every later request, and /clear takes it out of the window', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  on('tool.call' as any, { tool: 'Bash' } as any, () => ({ result: { stdout: 'y'.repeat(26_000), stderr: '' } }))
  await turn($)
  const trimmed = async () => /trimmed output ([\d.]+k?)/.exec(String((await ($ as any).command.run({ command: 'tokens', args: 'list', presentation: { columns: 160 } })).text))?.[1]
  await ($ as any).tool.call({ tool: 'Bash', command: 'cat big.log' })
  const once = await trimmed()
  expect(once).toBeDefined()
  expect(once).not.toBe('0')
  await turn($)
  await turn($)
  expect(await trimmed()).toBe(once)                           // was 2× and 3× before
  await ($ as any).command.run({ command: 'clear', args: '' })
  await turn($)
  expect(await trimmed()).toBe(once)
})

test('growth per message leaves out the first turn: the setup is not growth', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const ctx = { tokens: 0, window: 200_000, percent: 0 }
  const { clock } = setup(on, () => ({ context: { ...ctx }, rateLimits: [], cost: { usd: 0.5 } }))
  await turn($, () => { ctx.tokens = 54_000; ctx.percent = 27 })       // the first reply: setup and prompt
  await clock.advance(11_000)
  let ui: any = await mount($, 'terminal', PANE80)
  await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /^At 40%$/ })).toBeDefined()            // no growth measured yet: not "In ≈1 message"
  await turn($, () => { ctx.tokens = 60_000; ctx.percent = 30 })
  await clock.advance(11_000)
  await ui.unmount()
  ui = await mount($, 'terminal', PANE80)
  expect(await ui.find({ text: /^In ≈4 messages$/ })).toBeDefined()   // 20k to 40% at 6k a message
})

test('Clear from the pane starts the band over, as a typed /clear does', { options: { ...OPTIONS, cacheBand: true }, timeoutMs: SLOW }, async ($, on) => {
  let log: any
  ;({ log } = setup(on, () => (log && log.commands.some((c: any) => c.command === 'clear') ? { ...USAGE, context: { tokens: 12_000, window: 1_000_000, percent: 1 } } : USAGE)))
  on('ui.render' as any, (_$: any, e: any) => _$.ui.resolve(e).Box({}))      // the engine beneath, where the band passes
  await turn($)
  const band = () => ($ as any).ui.mount({ plugin: 'token-saver', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } })
  let b: any = await band()
  expect(await b.find({ text: /^[ \u00a0]?48%$/ })).toBeDefined()
  await b.unmount()
  const ui: any = await mount($, 'terminal')
  await ui.press({ key: 'ctx-clear' })
  expect(log.commands.map((c: any) => c.command)).toContain('clear')
  b = await band()
  expect(await b.find({ text: /^[ \u00a0]?48%$/ })).toBeUndefined()   // no figures from before the clear
})

test('the terminal pane: every action a plain Button, the recommended one orange, none bold or blue', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  await turn($)
  const ui: any = await mount($, 'terminal')
  for (const key of ['ctx-clear', 'ctx-compact', 'ctx-later']) {
    const b = await ui.find({ key })
    expect(b.props.plain).toBe(true)
    expect(b.props.variant).toBeUndefined()
  }
  const btns = await Promise.all(['ctx-clear', 'ctx-compact', 'ctx-later'].map((key) => ui.find({ key })))
  expect(btns.filter(lit).length).toBe(1)                          // one recommended action, in orange
  const all = await ui.findAll({ type: 'Text' })
  expect(all.some((x: any) => x.props.bold)).toBe(false)
  expect(all.some((x: any) => x.props.color === 'permission')).toBe(false)
})

test('the 54-column terminal dock gets the narrow layout: Saved splits, cards one per row', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  await turn($)
  const ui: any = await mount($, 'terminal', { ...PANE, bodyColumns: 54 })
  if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /^Cut \d+% of cost$/ })).toBeDefined()
  expect(await ui.find({ text: /^ this session$/ })).toBeDefined()
  // a card in a row of two or more has a fixed width; one a row grows instead: no fixed-width card at 54
  const fixed = (await ui.findAll({ type: 'Box' })).filter((b: any) => typeof b.props.width === 'number' && b.props.flexShrink === 0 && b.props.overflow === 'hidden')
  expect(fixed.length).toBe(0)
  expect(await ui.find({ text: /^10% of the$/ })).toBeUndefined()
})

test('/tokens list fits the transcript: the box at 120 columns, a list where a box cannot fit', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  await turn($)
  const list = async (columns: number) => String((await ($ as any).command.run({ command: 'tokens', args: 'list', presentation: { columns } })).text).split('\n')
  const wide = await list(120)
  expect(wide[0].startsWith('┌')).toBe(true)
  for (const l of wide.slice(0, -1)) expect(l.length).toBeLessThanOrEqual(114)       // behind "  ⎿  "
  const thin = await list(66)
  expect(thin.some((l) => l.startsWith('┌'))).toBe(false)
  for (const l of thin.slice(0, -1)) expect(l.length).toBeLessThanOrEqual(60)
  expect(thin.some((l) => /^Context +\d/.test(l))).toBe(true)
})

test('no /handoff anywhere a stranger reads it: hints, the pane, the glossary', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => ({ ...USAGE, context: { ...USAGE.context, tokens: 640_000, percent: 64 } }))
  await turn($)
  const learn = String((await ($ as any).command.run({ command: 'tokens', args: 'learn' })).text)
  const list = String((await ($ as any).command.run({ command: 'tokens', args: 'list', presentation: { columns: 160 } })).text)
  for (const s of [learn, list]) expect(s).not.toMatch(/\/handoff|write a handoff|\bhandoff \+/i)
  const ui: any = await mount($, 'desktop')
  if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /handoff/i })).toBeUndefined()
  expect(learn).toContain('Fading: still there')
})

// ---- 0.3.46: what the review found still in 0.3.45 ----

test('a cold /compact is booked once, typed twice or pressed, and dropped when it is forced', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const { clock, log } = setup(on, () => USAGE, STEP_TTL('5m'))
  await turn($)
  await clock.advance(10 * MIN)
  const vetoed = async () => /compactions vetoed ([^ ·│]+)/.exec(String((await ($ as any).command.run({ command: 'tokens', args: 'list', presentation: { columns: 200 } })).text))?.[1]
  const compact = (instructions = '') => ($ as any).session.compact({ trigger: 'manual', instructions, messages: [{ role: 'user', text: 'hello', toolUses: [] }] })
  expect(String((await compact()).skip)).toContain('prompt cache has lapsed')
  expect(await vetoed()).toBe('605k')                              // 484k × 1.25, once
  await compact()
  const ui: any = await mount($, 'terminal')
  await ui.press({ key: 'ctx-compact' })
  await ui.unmount()
  expect(await vetoed()).toBe('605k')                              // the same held compaction, not three
  await compact('force')
  expect(log.compacts.length).toBe(1)
  expect(await vetoed()).toBe('0')                                 // it ran after all: nothing was held
})

test('an unknown /tokens argument answers with usage, not the list', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  await turn($)
  const r = String((await ($ as any).command.run({ command: 'tokens', args: 'lsit' })).text)
  expect(r).toMatch(/^usage: \/tokens/)
  expect(r).not.toContain('│')
  expect(String((await ($ as any).command.run({ command: 'tokens', args: 'list', presentation: { columns: 160 } })).text)).toContain('│ Context')
})

test('keep-warm prices a ping at the model\'s read rate, not 0.1× everywhere', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  await turn($)                                                    // claude-sonnet-5-5: reads at 0.05×
  const ui: any = await mount($, 'desktop')
  if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /0\.05× each$/ })).toBeDefined()
  expect(await ui.find({ text: /0\.1× each$/ })).toBeUndefined()
})

test('past a mark the band, the pane and the toast say the same thing', { options: { ...OPTIONS, cacheBand: true, compactHint: true }, timeoutMs: SLOW }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  let ctx = { tokens: 110_000, window: 200_000, percent: 55 }
  const toasts: string[] = []
  on('session.usage' as any, () => ({ value: { context: { ...ctx }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete' as any, () => ({ text: 'ok' }))
  on('turn.step' as any, async function* () { return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: STEP } })
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e.text)); return { value: undefined } })
  for (const ev of ['ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))
  on('ui.render' as any, (_$: any, e: any) => _$.ui.resolve(e).Box({}))
  await turn($)                                                    // 55%: past watch
  ctx = { tokens: 124_000, window: 200_000, percent: 62 }
  await turn($)                                                    // crosses 60%: the toast
  const toast = toasts.find((x) => /^context 62% — /.test(x))
  expect(toast).toBe('context 62% — past your 60% mark: ask Claude for a summary of where you are (cheap while the cache is warm, 5m left), then Clear')
  const advice = /^[  ]?Past your 60% mark: ask Claude for a summary of where you are \(cheap while the cache is warm, 5m left\), then Clear[  ]?$/
  const band: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 160 } })
  expect(await band.find({ text: advice })).toBeDefined()
  await band.unmount()
  const pane: any = await mount($, 'terminal')
  expect(await pane.find({ text: advice })).toBeDefined()
})

// ---- 0.3.47: what the retest of 0.3.46 on the real CLI found ----

/** A session whose usage is `plain` from the plain call and `full` (with its breakdown) from a summary call, as the engine answers. */
function windowed(on: any, plain: () => any, full: () => any, env: Record<string, string> = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home', ...env })
  const toasts: string[] = []
  on('session.usage' as any, (_$: any, e: any) => ({ value: e && e.breakdown ? full() : plain() }))
  on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete' as any, () => ({ text: 'ok' }))
  on('turn.step' as any, async function* () { return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: STEP } })
  on('command.run' as any, () => ({ text: 'ran' }))
  on('ui.toast' as any, (_$: any, e: any) => { toasts.push(String(e.text)); return { value: undefined } })
  for (const ev of ['ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))
  return { clock, toasts }
}
const cat = (name: string, tokens: number, kind = 'used') => ({ name, tokens, color: 'inactive', isDeferred: false, kind })
// /autocompact 100k as the real engine reports it: the plain call keeps the model's 1M window; the breakdown has the set one
const SET100K = (messages: number, setup: number) => ({
  ...BREAKDOWN, totalTokens: messages + setup, maxTokens: 100_000, rawMaxTokens: 100_000, percentage: ((messages + setup) * 100) / 100_000,
  autoCompactThreshold: 67_000, isAutoCompactEnabled: true,
  categories: [cat('System prompt', 5_000), cat('System tools', setup - 5_000), cat('Messages', messages), cat('Free space', 100_000 - messages - setup - 33_000, 'free'), cat('Autocompact buffer', 33_000, 'buffer')],
})

test('a set auto-compact window: the title, the band, the marks and the toast count against it, as /context does', { options: { ...OPTIONS, cacheBand: true, compactHint: true }, timeoutMs: SLOW }, async ($, on) => {
  const bd = SET100K(35_000, 20_000)                                // 55k of 100k; auto-compact at 67k scales the marks to 27/40/50%
  const plain = () => ({ context: { tokens: 55_000, window: 1_000_000, percent: 5 }, rateLimits: [], cost: { usd: 0.1 } })
  const { toasts } = windowed(on, plain, () => ({ ...plain(), context: { ...plain().context, breakdown: bd } }))
  await turn($)
  const pane: any = await mount($, 'terminal')
  expect(await pane.find({ text: /^55k \/ 100k \(55%\)$/ })).toBeDefined()            // never "55k / 1M (55%)"
  const advice = /^[  ]?Past your 50% mark: Compact now, while the cache is warm \(5m left\)[  ]?$/
  expect(await pane.find({ text: advice })).toBeDefined()
  await pane.unmount()
  const band: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 160 } })
  expect(await band.find({ text: /^ ?55%$/ })).toBeDefined()                             // never 5% of the model's window
  expect(await band.find({ text: advice })).toBeDefined()
  expect(toasts.some((t) => /^context 55% — past your 50% mark: Compact now/.test(t))).toBe(true)
})

test('a window that is mostly setup: past the marks, Compact and Clear are not pushed, and the hint says why', { options: { ...OPTIONS, cacheBand: true, compactHint: true }, timeoutMs: SLOW }, async ($, on) => {
  const bd = SET100K(7_000, 48_000)                                 // 55k, but only 7k is conversation
  const plain = () => ({ context: { tokens: 55_000, window: 1_000_000, percent: 5 }, rateLimits: [], cost: { usd: 0.1 } })
  windowed(on, plain, () => ({ ...plain(), context: { ...plain().context, breakdown: bd } }))
  await turn($)
  const pane: any = await mount($, 'terminal')
  expect(await pane.find({ text: /^[  ]?Past your 50% mark, but ≈48k of it is setup that loads every time: Compact or Clear would free only ≈7k\. \/context shows what loads\.[  ]?$/ })).toBeDefined()
  expect(lit(await pane.find({ key: 'ctx-compact' }))).toBe(false)
  expect(lit(await pane.find({ key: 'ctx-later' }))).toBe(true)
  await pane.press({ key: 'ctx-expand' })
  expect(await pane.find({ text: /^Mostly setup$/ })).toBeDefined()                      // the next-mark card, not "Compact · Now"
})

test('right after /clear there is nothing to compact: the pane draws Compact unavailable', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => USAGE)
  await turn($)
  await ($ as any).command.run({ command: 'clear', args: '' })
  const ui: any = await mount($, 'terminal')
  expect((await ui.find({ key: 'ctx-compact' }))?.props.dimColor).toBe(true)
  expect(lit(await ui.find({ key: 'ctx-compact' }))).toBe(false)
})

test('a lapsed cache: the veto offers /clear and compacting after the next message, never a summary that costs the same', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => USAGE)
  await turn($)
  await clock.advance(10 * MIN)
  const r: any = await ($ as any).session.compact({ trigger: 'manual', instructions: '' })
  const text = String(r && r.skip)
  expect(text).toContain('/clear is free')
  expect(text).toContain('compact after that, while it is warm')
  expect(text).not.toMatch(/summary/i)
})

test('the idle card on a 5-minute cache set in the environment says it does not run here, from the first reply on', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const plain = () => ({ context: { tokens: 250_000, window: 1_000_000, percent: 25 }, rateLimits: [], cost: { usd: 0.1 } })
  windowed(on, plain, () => ({ ...plain(), context: { ...plain().context, breakdown: { ...BREAKDOWN, totalTokens: 250_000, percentage: 25 } } }), { CLAUDE_CODE_PROMPT_CACHE_TTL: '5m' })
  await turn($)
  const ui: any = await mount($, 'terminal')
  await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /^This session caches for 5 minutes$/ })).toBeDefined()
  expect(await ui.find({ text: /Learned from the next reply/ })).toBeUndefined()
})
