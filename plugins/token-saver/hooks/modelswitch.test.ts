import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
const MIN = 60_000
const USED = 142_000
const STEP = { input_tokens: 2_000, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 0, output_tokens: 400 }
const API = { context: { tokens: USED, window: 1_000_000, percent: 14 }, rateLimits: [], cost: { usd: 1.37 } }
const OPTIONS = { suggestSkills: false, cacheBand: false, keepWarm: false, inputPricePerM: 3 }   // priced: $3/M input
const SLOW = 30_000

type Log = { asks: any[], toasts: string[], statuses: any[], steps: any[] }

function wire(on: any, usage: () => any, log: Log, answer: () => Promise<string> | string = () => 'Stay') {
  on('session.usage' as any, () => ({ value: usage() }))
  on('session.start' as any, (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete' as any, () => ({ text: 'ok' }))
  on('turn.step' as any, async function* (_$: any, e: any) {
    log.steps.push(e)
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: STEP }
  })
  // $.ui.ask is a tool.call of AskUserQuestion through the hooks; the test answers it like the engine would
  on('tool.call' as any, { tool: 'AskUserQuestion' } as any, async (_$: any, e: any) => {
    const q = e.questions[0]
    log.asks.push({ question: q.question, header: q.header, options: q.options.map((o: any) => o.label) })
    const a = await answer()
    return { result: { questions: e.questions, answers: { [q.question]: a } } }
  })
  on('ui.toast' as any, (_$: any, e: any) => { log.toasts.push(String(e.text)); return { value: undefined } })
  on('ui.status' as any, (_$: any, e: any) => { log.statuses.push(e.text); return { value: undefined } })
  for (const ev of ['ui.log', 'command.register']) on(ev as any, () => ({ value: undefined }))   // never stub ui.invalidate: the kit redraws on it
  on('classic.PreModelSwitch' as any, () => ({}))                     // the engine beneath: allows
}

function setup(on: any, usage: () => any, answer?: () => Promise<string> | string) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const log: Log = { asks: [], toasts: [], statuses: [], steps: [] }
  wire(on, usage, log, answer)
  return { clock, log }
}

/** One whole turn: start, one main-thread step, complete. */
async function turn($: any, model = 'claude-fable-5-1') {
  await $.turn.start({ text: 'hi', turnId: 't' })
  const s = $.turn.step({ turnId: 't', index: 0, model, messageCount: 1 })
  for await (const _ of s) { /* drain */ }
  await s.result
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'ok', text: 'ok' })
}

const SWITCH = (over: any = {}) => ({
  hook_event_name: 'PreModelSwitch', session_id: 's', transcript_path: '/t', cwd: '/repo',
  from_model: 'claude-fable-5-1', to_model: 'claude-opus-5-5', requested_model: 'opus', source: 'picker',
  context_tokens: USED, prompt_cache_warm: true, cache_ttl: '5m', estimated_cache_write_usd: 0.53, pricing: 'catalog', ...over,
})

const mount = ($: any) => $.ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'Pane', requestId: 'context',
  props: { title: 'Context', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })

const POST = (over: any = {}) => ({
  hook_event_name: 'PostModelSwitch', session_id: 's', transcript_path: '/t', cwd: '/repo',
  from_model: 'claude-fable-5-1', to_model: 'claude-opus-5-5', requested_model: 'opus', source: 'picker', context_tokens: USED, ...over,
})
const receipt = async ($: any) => {
  const ui: any = await mount($)
  if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
  await ui.press({ key: 'ctx-receipt' })
  return ui
}

test('warm and large on the API: the engine asks, carrying the price; the hook opens no dialog of its own', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { log } = setup(on, () => API)
  await turn($)
  const r: any = await $.classic.PreModelSwitch(SWITCH())
  expect(log.asks).toHaveLength(0)                                   // a dialog opened here waits behind the hook: the switch hung
  expect(r.permissionDecision).toBe('ask')
  expect(r.permissionDecisionReason).toContain('142.0k tokens')
  expect(r.permissionDecisionReason).toContain("$0.53 at Opus 5.5's list price")
})

test('declined: nothing is booked, neither held nor paid', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => API)
  await turn($)
  await $.classic.PreModelSwitch(SWITCH())                           // the engine's dialog says No, or Esc: no PostModelSwitch follows
  const ui = await receipt($)
  expect(await ui.find({ text: /held/ })).toBeUndefined()
  expect(await ui.find({ text: /^Model switches, cold re-read \(not a saving\)$/ })).toBeUndefined()
  expect(await ui.find({ text: /^Total saved$/ })).toBeDefined()
  expect(await ui.find({ text: /^0 tokens$/ })).toBeDefined()
})

test('switched: PostModelSwitch books the cold re-read as paid, never as saved', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => API)
  on('classic.PostModelSwitch' as any, () => ({}))
  await turn($)
  await $.classic.PreModelSwitch(SWITCH())
  await $.classic.PostModelSwitch(POST())
  const ui = await receipt($)
  expect(await ui.find({ text: /^Model switches, cold re-read \(not a saving\)$/ })).toBeDefined()
  expect(await ui.find({ text: /^177\.5k/ })).toBeDefined()          // 142k × 1.25
  expect(await ui.find({ text: /^0 tokens$/ })).toBeDefined()        // nothing counted as saved
})

test('on the one-hour cache the reason and the receipt price the re-write at 2×', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  setup(on, () => API)
  on('classic.PostModelSwitch' as any, () => ({}))
  await turn($)
  const r: any = await $.classic.PreModelSwitch({ ...SWITCH(), cache_ttl: '1h' })
  expect(r.permissionDecisionReason).toContain('at 2× the input price')
  await $.classic.PostModelSwitch(POST())
  const ui = await receipt($)
  expect(await ui.find({ text: /^284k/ })).toBeDefined()             // 142k × 2
})

test('subscription: the reason prices the switch as window headroom and never shows a dollar', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  let pct = 10
  const usage = () => ({ context: { tokens: USED, window: 1_000_000, percent: 14 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct }], cost: { usd: 0.4 } })
  setup(on, () => usage())
  await turn($)                                                      // the window's base at 10%
  pct = 12
  await turn($)                                                      // 142k tokens moved the window 2%: 71k per %
  const r: any = await $.classic.PreModelSwitch(SWITCH())
  expect(r.permissionDecisionReason).toContain('% of your 5-hour window')
  expect(r.permissionDecisionReason).not.toContain('$')
})

test('a plan with only the weekly window prices the switch against the week', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  let pct = 8
  const usage = () => ({ context: { tokens: USED, window: 1_000_000, percent: 14 }, rateLimits: [{ kind: 'seven_day', percentUsed: pct }], cost: { usd: 0 } })
  setup(on, () => usage())
  await turn($)
  pct = 10
  await turn($)
  const r: any = await $.classic.PreModelSwitch(SWITCH())
  expect(r.permissionDecisionReason).toContain('% of your weekly window')
  expect(r.permissionDecisionReason).not.toContain('$')
})

test('cold cache: no dialog, one toast says the switch is free, the switch goes through', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { log } = setup(on, () => API)
  await turn($)
  const r: any = await $.classic.PreModelSwitch(SWITCH({ prompt_cache_warm: false }))
  expect(log.asks).toHaveLength(0)
  expect(log.toasts).toHaveLength(1)
  expect(log.toasts[0]).toContain('free right now')
  expect(r.permissionDecision).toBeUndefined()
})

test('small context: no dialog, one toast says it is cheap', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { log } = setup(on, () => API)
  await turn($)
  const r: any = await $.classic.PreModelSwitch(SWITCH({ context_tokens: 8_000 }))
  expect(log.asks).toHaveLength(0)
  expect(log.toasts[0]).toContain('cheap')
  expect(r.permissionDecision).toBeUndefined()
})

test('modelGuard off, a subagent, or a headless switch: untouched', { options: { ...OPTIONS, modelGuard: false }, timeoutMs: SLOW }, async ($, on) => {
  const { log } = setup(on, () => API)
  await turn($)
  await $.classic.PreModelSwitch(SWITCH())
  expect(log.asks).toHaveLength(0)
  expect(log.toasts).toHaveLength(0)
})

test('a subagent or an SDK switch is never questioned even with the guard on', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { log } = setup(on, () => API)
  await turn($)
  await $.classic.PreModelSwitch(SWITCH({ agent_id: 'a1' }))
  await $.classic.PreModelSwitch(SWITCH({ source: 'sdk' }))
  expect(log.asks).toHaveLength(0)
  expect(log.toasts).toHaveLength(0)
})

test('the Context pane prices a switch on its cache card: warm and large shows the dollars, cold says free', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const { clock } = setup(on, () => API)
  await turn($)
  const expand = async (u: any) => { if ((await u.find({ key: 'ctx-expand' }))?.props.label === 'More') await u.press({ key: 'ctx-expand' }) }
  let ui: any = await mount($)
  await expand(ui)
  expect(await ui.find({ text: /^Switch model ≈ \$0\.53$/ })).toBeDefined()   // 142k × 1.25 at $3/M
  await ui.unmount()
  await clock.advance(6 * MIN)                                       // past the 5-minute TTL
  ui = await mount($)
  await expand(ui)
  expect(await ui.find({ text: /^Switch model: free$/ })).toBeDefined()
})
