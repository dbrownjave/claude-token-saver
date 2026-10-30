import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const MIN = 60_000
const PREFIX = 100_000
const HIT = { input_tokens: 40, cache_read_input_tokens: PREFIX, cache_creation_input_tokens: 0, output_tokens: 2 }
const MISS = { input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: PREFIX, output_tokens: 2 }
const API = { context: { tokens: PREFIX, window: 200_000, percent: 50 }, rateLimits: [], cost: { usd: 3.1 } }
const SUBSCRIPTION = { context: { tokens: PREFIX, window: 200_000, percent: 50 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] }
const OPTIONS = { suggestSkills: false, cacheBand: false }
// A main-thread write as the API reports it, split by TTL bucket
const WRITE = (ttl: '5m' | '1h') => ({ ...HIT, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: ttl === '5m' ? 500 : 0, ephemeral_1h_input_tokens: ttl === '1h' ? 500 : 0 } })
const SWITCH = (cache_ttl: '5m' | '1h') => ({
  hook_event_name: 'PreModelSwitch', session_id: 's', transcript_path: '/t', cwd: '/repo', from_model: 'claude-sonnet-5-5', to_model: 'claude-opus-5-5',
  requested_model: 'opus', source: 'command', context_tokens: PREFIX, prompt_cache_warm: false, cache_ttl, estimated_cache_write_usd: 0.3, pricing: 'catalog',
})
// These tests walk the mocked clock through 30–50 idle minutes; give them room on a loaded machine.
const SLOW = 30_000

function wire(on: any, usage: any, forks: any[], forkUsage: () => any = () => HIT, step: () => any = () => HIT) {
  on('session.usage' as any, () => ({ value: usage }))
  on('session.start' as any, (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete' as any, () => ({ text: 'ok' }))
  on('model.fork' as any, (_$: any, e: any) => { forks.push(e); return { value: { isAnswered: true, text: '.', usage: forkUsage() } } })
  on('turn.step' as any, async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: step() }
  })
  on('classic.PreModelSwitch' as any, () => ({}))
  for (const ev of ['ui.toast', 'ui.status', 'ui.log', 'ui.invalidate', 'command.register']) on(ev as any, () => ({ value: undefined }))
}

/** One whole turn as the engine runs it: start, one main-thread step, complete. */
async function turn($: any) {
  await $.turn.start({ text: 'hi', turnId: 't' })
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
  for await (const _ of s) { /* drain */ }
  await s.result
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'ok', text: 'ok' })
}

/** Walk the mocked clock a minute at a time, so each 15 s keep-warm tick settles before the next. */
async function idle(clock: any, ms: number) {
  for (let left = ms; left > 0; left -= Math.min(left, MIN)) await clock.advance(Math.min(left, MIN))
}

async function tokensText($: any) {
  const r = await $.command.run({ command: 'tokens', args: '' })
  return String(r.text)
}

test('keep-warm pings just before the 5-minute TTL lapses, stops at the cap, and books the avoided re-write', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks)
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)

  await idle(clock, 3.5 * MIN)
  expect(forks.length).toBe(0)                              // not yet: more than 75 s of TTL left
  await idle(clock, 0.5 * MIN)
  expect(forks.length).toBe(1)                              // within the lead: one ping
  expect(String(forks[0].prompt)).toContain('single period')

  await idle(clock, 40 * MIN)
  expect(forks.length).toBe(5)                              // the cap: five pings per idle stretch, then let it lapse

  // Back long after the cap let it lapse: the pings did not cover the gap, so nothing is booked as avoided.
  await turn($)
  let text = await tokensText($)
  expect(text).toContain('5 pings · avoided 0 ·')

  // A stretch the pings cover: come back after 9 minutes (would have lapsed at 5), cache still warm.
  const before = forks.length
  await idle(clock, 9 * MIN)
  await turn($)
  expect(forks.length - before).toBe(2)
  text = await tokensText($)
  expect(text).toContain('7 pings · avoided 120.0k')
})

test('keep-warm stays off on a subscription: the main thread already caches for an hour and pings would spend quota', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, SUBSCRIPTION, forks)
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await idle(clock, 30 * MIN)
  expect(forks.length).toBe(0)
  expect(await tokensText($)).toContain('off (not API billing)')
})

test('keep-warm never pings during a turn, and stops a stretch on a miss', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks, () => MISS)
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await ($ as any).turn.start({ text: 'long one', turnId: 't2' })
  await idle(clock, 10 * MIN)
  expect(forks.length).toBe(0)                              // a turn is running
  await ($ as any).turn.complete({ turnId: 't2', reason: 'answer', answer: 'ok', text: 'ok' })

  await turn($)
  await idle(clock, 30 * MIN)
  expect(forks.length).toBe(1)                              // the ping missed: the cache had gone, so stop paying
})

test('keep-warm can be turned off', { options: { ...OPTIONS, keepWarm: false }, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks)
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await idle(clock, 30 * MIN)
  expect(forks.length).toBe(0)
  expect(await tokensText($)).toContain('│ off')
})

test('keep-warm turns itself off when the engine writes to the one-hour cache, with no option set', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks, () => HIT, () => WRITE('1h'))
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await idle(clock, 30 * MIN)
  expect(forks.length).toBe(0)                              // a 5-minute ping would be wasted on an hour-long TTL
  const text = await tokensText($)
  expect(text).toContain('off (one-hour cache)')
  expect(text).toContain('Chill 30m')
})

test('keep-warm keeps pinging when the engine writes to the 5-minute cache', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks, () => HIT, () => WRITE('5m'))
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await idle(clock, 4 * MIN)
  expect(forks.length).toBe(1)
})

test('keep-warm follows the TTL a model switch reports: off on one hour, back on at five minutes', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks)
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await ($ as any).classic.PreModelSwitch(SWITCH('1h'))
  await idle(clock, 10 * MIN)
  expect(forks.length).toBe(0)

  await ($ as any).classic.PreModelSwitch(SWITCH('5m'))
  await turn($)
  await idle(clock, 4 * MIN)
  expect(forks.length).toBe(1)
})

test('longCacheTtl overrides a 5-minute engine reading: no pings', { options: { ...OPTIONS, longCacheTtl: true }, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks, () => HIT, () => WRITE('5m'))
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await idle(clock, 10 * MIN)
  expect(forks.length).toBe(0)
})

test('a subagent finishing mid-turn leaves the main turn running: keep-warm stays quiet', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks)
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await ($ as any).turn.start({ text: 'long one', turnId: 't2' })
  await ($ as any).turn.start({ text: 'sub', turnId: 'a1', agentId: 'a1' })
  await ($ as any).turn.complete({ turnId: 'a1', agentId: 'a1', reason: 'answer', answer: 'ok', text: 'ok' })
  await idle(clock, 10 * MIN)
  expect(forks.length).toBe(0)                              // the main turn is still running
})

test('a subagent starting after the reply does not hold keep-warm back', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const forks: any[] = []
  wire(on, API, forks)
  await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
  await turn($)
  await ($ as any).turn.start({ text: 'background', turnId: 'a1', agentId: 'a1' })
  await idle(clock, 4 * MIN)
  expect(forks.length).toBe(1)                              // the main thread is idle, so its ping still goes out
})

// 10k input, 2M read, 20k written, 5k output: the bill divided by these units gives the model's base input price back.
const STEP = { input_tokens: 10_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 20_000, output_tokens: 5_000 }
for (const [model, usd, cc, rate] of [
  ['claude-opus-5-5', 0.64, undefined, '$4.00'],                                                   // reads 0.05×: 160k units
  ['claude-sonnet-5-5', 0.32, undefined, '$2.00'],                                                 // reads 0.05×: 160k units
  ['claude-fable-5-1', 1.1, undefined, '$10.00'],                                                  // reads 0.025×: 110k units
  ['claude-haiku-5-5', 0.026, undefined, '$0.10'],                                                 // reads 0.1×: 260k units
  ['claude-opus-5-5', 0.7, { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20_000 }, '$4.00'],   // one-hour writes 2×: 175k units
] as const) {
  test(`the derived rate on ${model}${cc ? ', one-hour writes,' : ''} comes back to its input price`, { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    mock.env(on, { HOME: '/nonexistent-home' })
    on('session.usage' as any, () => ({ value: { ...API, cost: { usd } } }))
    on('session.start' as any, (_$: any, e: any) => ({ cwd: e.cwd }))
    on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
    on('turn.complete' as any, () => ({ text: 'ok' }))
    on('turn.step' as any, async function* () {
      return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { ...STEP, ...(cc ? { cache_creation: cc } : {}) } }
    })
    for (const ev of ['ui.toast', 'ui.status', 'ui.log', 'command.register']) on(ev as any, () => ({ value: undefined }))   // not ui.invalidate: the receipt redraws through it
    await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })
    await ($ as any).turn.start({ text: 'hi', turnId: 't' })
    const s = ($ as any).turn.step({ turnId: 't', index: 0, model, messageCount: 1 })
    for await (const _ of s) { /* drain */ }
    await s.result
    await ($ as any).turn.complete({ turnId: 't', reason: 'answer', answer: 'ok', text: 'ok' })
    const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'Pane', requestId: 'context',
      props: { title: 'Context', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
    if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
    await ui.press({ key: 'ctx-receipt' })
    expect(await ui.find({ text: `At ≈${rate}/M input, derived from this session's bill` })).toBeDefined()
  })
}
