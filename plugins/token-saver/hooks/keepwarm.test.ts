import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const MIN = 60_000
const PREFIX = 100_000
const HIT = { input_tokens: 40, cache_read_input_tokens: PREFIX, cache_creation_input_tokens: 0, output_tokens: 2 }
const MISS = { input_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: PREFIX, output_tokens: 2 }
const API = { context: { tokens: PREFIX, window: 200_000, percent: 50 }, rateLimits: [], cost: { usd: 3.1 } }
const SUBSCRIPTION = { context: { tokens: PREFIX, window: 200_000, percent: 50 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }] }
const OPTIONS = { suggestSkills: false, cacheBand: false }
// These tests walk the mocked clock through 30–50 idle minutes; give them room on a loaded machine.
const SLOW = 30_000

function wire(on: any, usage: any, forks: any[], forkUsage: () => any = () => HIT) {
  on('session.usage' as any, () => ({ value: usage }))
  on('session.start' as any, (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete' as any, () => ({ text: 'ok' }))
  on('model.fork' as any, (_$: any, e: any) => { forks.push(e); return { value: { isAnswered: true, text: '.', usage: forkUsage() } } })
  on('turn.step' as any, async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: HIT }
  })
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
  expect(text).toContain('7 pings · avoided 115.0k')
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
