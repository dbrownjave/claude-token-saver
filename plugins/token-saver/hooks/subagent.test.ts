import { test, expect, mock } from 'claude-code/testing'

/**
 * Subagent cache lapses: a subagent's request more than 5 minutes after its previous one, that wrote its context again
 * instead of reading it, is a lapse. The receipt lists the re-write as a cost that is never a saving; the pane names
 * the agent type a 1-hour cache would have paid for, net of the 2× write price; the store keeps a week count per type.
 */

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
const MIN = 60_000
const MAIN_STEP = { input_tokens: 2_000, cache_read_input_tokens: 140_000, cache_creation_input_tokens: 0, output_tokens: 400 }
const WRITE = (n: number) => ({ input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: n, output_tokens: 200 })
const READ = (n: number) => ({ input_tokens: 500, cache_read_input_tokens: n, cache_creation_input_tokens: 0, output_tokens: 200 })
const API = { context: { tokens: 142_000, window: 1_000_000, percent: 14 }, rateLimits: [], cost: { usd: 1.37 } }
const CREDITS = { context: { tokens: 142_000, window: 1_000_000, percent: 14 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], cost: { usd: 0.4 } }
const OPTIONS = { suggestSkills: false, cacheBand: false, keepWarm: false, inputPricePerM: 3 }
const SLOW = 30_000

type Log = { steps: any[] }

function setup(on: any, usage: () => any, store: Record<string, any> = {}) {
  const clock = mock.clock(on, { now: NOW })
  const st = new Map<string, any>(Object.entries(store))
  // an in-memory $.store the test can read back (mock.store keeps its entries to itself)
  on('store.get' as any, (_$: any, e: any) => ({ value: st.has(e.key) ? st.get(e.key) : undefined }))
  on('store.set' as any, (_$: any, e: any) => { st.set(e.key, e.value); return { value: undefined } })
  on('store.delete' as any, (_$: any, e: any) => { st.delete(e.key); return { value: undefined } })
  on('store.keys' as any, () => ({ value: [...st.keys()] }))
  mock.env(on, { HOME: '/nonexistent-home' })
  const log: Log = { steps: [] }
  let nextUsage: any = MAIN_STEP
  on('session.usage' as any, () => ({ value: usage() }))
  on('session.start' as any, (_$: any, e: any) => ({ cwd: e.cwd }))
  on('turn.start' as any, (_$: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete' as any, () => ({ text: 'ok' }))
  on('turn.step' as any, async function* (_$: any, e: any) {
    log.steps.push(e)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: nextUsage }
  })
  on('ui.toast' as any, () => ({ value: undefined }))
  on('ui.status' as any, () => ({ value: undefined }))
  for (const ev of ['ui.log', 'command.register']) on(ev as any, () => ({ value: undefined }))
  on('classic.SubagentStart' as any, () => ({}))
  on('classic.SubagentStop' as any, () => ({}))
  const step = async ($: any, agentId: string | undefined, usage: any, index = 0) => {
    nextUsage = usage
    const s = $.turn.step({ turnId: agentId ? `t-${agentId}` : 't', index, model: 'claude-sonnet-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of s) { /* drain */ }
    await s.result
  }
  return { clock, log, store: st, step }
}

/** One main-thread turn so the pane has a cache clock. */
async function mainTurn($: any, step: any) {
  await $.turn.start({ text: 'hi', turnId: 't' })
  await step($, undefined, MAIN_STEP)
  await $.turn.complete({ turnId: 't', reason: 'answer', answer: 'ok', text: 'ok' })
}

const START = (id: string, type = 'Explore') => ({ hook_event_name: 'SubagentStart', session_id: 's', transcript_path: '/t', cwd: '/repo', agent_id: id, agent_type: type })

/** A whole subagent run: start, a first write, a gap, a second request, its answer. */
async function agentRun($: any, h: any, id: string, type: string, gapMin: number, second: any, first = WRITE(50_000)) {
  await $.classic.SubagentStart(START(id, type))
  await h.step($, id, first, 0)
  for (let i = 0; i < gapMin; i++) await h.clock.advance(MIN)
  await h.step($, id, second, 1)
  await $.turn.complete({ turnId: `t-${id}`, reason: 'answer', answer: 'ok', text: 'ok', agentId: id })
}

const mount = ($: any) => $.ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'Pane', requestId: 'context',
  props: { title: 'Context', isFocused: true, bodyColumns: 160, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} } })

async function openReceipt($: any) {
  const ui: any = await mount($)
  if ((await ui.find({ key: 'ctx-expand' }))?.props.label === 'More') await ui.press({ key: 'ctx-expand' })
  await ui.press({ key: 'ctx-receipt' })
  return ui
}

test('a 6-minute gap followed by a cold write is a lapse: a receipt row that is a cost, a pane line naming the agent, Saved untouched', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const h = setup(on, () => API)
  await mainTurn($, h.step)
  await agentRun($, h, 'a1', 'Explore', 6, WRITE(50_000))
  const ui = await openReceipt($)
  expect(await ui.find({ text: /^Agents re-read after a long wait \(not a saving\)$/ })).toBeDefined()
  expect(await ui.find({ text: /^62\.5k$/ })).toBeDefined()                         // 50k written again × 1.25
  expect(await ui.find({ text: /^Total saved$/ })).toBeDefined()
  expect(await ui.find({ text: /^0 tokens$/ })).toBeDefined()                       // the lapse is never counted as saved
  // net = 1.15 × 50k lapsed − 0.75 × 50k other writes = 20k
  expect(await ui.find({ text: /^The Explore agent waited over 5 minutes 1× this session and re-read 50k tokens\. A 1-hour cache for it would have saved ≈ 20k tokens: put cacheTtl: 1h under experimental in its agent file\.$/ })).toBeDefined()
})

test('a gap followed by a cache hit is not a lapse: a longer cache was already in force', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const h = setup(on, () => API)
  await mainTurn($, h.step)
  await agentRun($, h, 'a1', 'Explore', 6, READ(50_000))
  const ui = await openReceipt($)
  expect(await ui.find({ text: /^Agents re-read after a long wait/ })).toBeUndefined()
  expect(await ui.find({ text: /^The Explore agent/ })).toBeUndefined()
})

test('a 4-minute gap is inside the TTL: no lapse even when the request writes', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const h = setup(on, () => API)
  await mainTurn($, h.step)
  await agentRun($, h, 'a1', 'Explore', 4, WRITE(50_000))
  const ui = await openReceipt($)
  expect(await ui.find({ text: /^Agents re-read after a long wait/ })).toBeUndefined()
})

test("subagent steps never touch the main thread's cache clock or turn count", { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const h = setup(on, () => API)
  await mainTurn($, h.step)
  const list = async () => String((await $.command.run({ command: 'tokens', args: 'list', presentation: { columns: 160 } })).text)
  expect(await list()).toMatch(/│ Cache +│ Very warm/)
  await agentRun($, h, 'a1', 'Explore', 6, WRITE(50_000))       // the clock moved 6 minutes; the agent's last step was just now
  const after = await list()
  expect(after).toMatch(/│ Cache +│ Frozen/)                       // idle 6m past the 5m TTL: the agent's steps did not refresh the main clock
  expect(after).toMatch(/│ Agents +│ 1 re-read after a long wait/)
  expect(h.log.steps.filter((s) => !s.agentId)).toHaveLength(1)
})

test('the store carries a week count per agent type: "3 times this week" with two earlier lapses on record', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const weekKey = '2026-W41'                                                          // 10 Oct 2026 is a Saturday in ISO week 41
  const h = setup(on, () => API, { 'lapses:Explore': { weekKey, weekCount: 2, weekTok: 100_000, allCount: 5, allTok: 250_000 } })
  await mainTurn($, h.step)
  await agentRun($, h, 'a1', 'Explore', 6, WRITE(50_000))
  const ui = await openReceipt($)
  expect(await ui.find({ text: /waited over 5 minutes 1× this session \(3 this week\)/ })).toBeDefined()
  const row: any = h.store.get('lapses:Explore')
  expect(row.weekKey).toBe(weekKey)
  expect(row.weekCount).toBe(3)
  expect(row.allCount).toBe(6)
  expect(row.weekTok).toBe(162_500)
})

test('on usage credits the lapse is still measured but the 1-hour recommendation is not made', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const h = setup(on, () => CREDITS)
  await mainTurn($, h.step)
  await agentRun($, h, 'a1', 'Explore', 6, WRITE(50_000))
  const ui = await openReceipt($)
  expect(await ui.find({ text: /^Agents re-read after a long wait \(not a saving\)$/ })).toBeDefined()
  expect(await ui.find({ text: /^The Explore agent/ })).toBeUndefined()
})

test('a small lapse after many warm writes: the 1-hour cache would not pay, and the line says so', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const h = setup(on, () => API)
  await mainTurn($, h.step)
  await agentRun($, h, 'a1', 'Plan', 6, WRITE(10_000), WRITE(200_000))          // 1.15 × 10k − 0.75 × 200k < 0
  const ui = await openReceipt($)
  expect(await ui.find({ text: /^The Plan agent waited over 5 minutes 1× this session and re-read 10k tokens\. A 1-hour cache would cost more than it saves here; shorten its waits instead\.$/ })).toBeDefined()
})

test('/tokens list gains an Agents row once an agent has re-read, and /tokens learn agents explains it', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  const h = setup(on, () => API)
  await mainTurn($, h.step)
  const none: any = await $.command.run({ command: 'tokens', args: 'list', presentation: { columns: 160 } })
  expect(none.text).not.toContain('Subagents')
  await agentRun($, h, 'a1', 'Explore', 6, WRITE(50_000))
  const r: any = await $.command.run({ command: 'tokens', args: 'list', presentation: { columns: 160 } })
  expect(r.text).toMatch(/│ Agents +│ 1 re-read after a long wait · 62\.5k tokens +│ the Explore agent waited over 5 minutes 1× this session/)
  const learn: any = await $.command.run({ command: 'tokens', args: 'learn agents' })
  expect(learn.text).toContain('Agents: Each agent Claude starts remembers what it has read for 5 minutes.')
  expect(learn.text).toContain('1 re-read after a long wait, 62.5k tokens, not counted as saved.')
  expect(learn.text).toContain('→ The Explore agent waited over 5 minutes 1× this session')
})

test('a 1M window with auto-compact above 900k: the pane and /tokens say to run /autocompact 400k; at 400k they do not', { options: OPTIONS, timeoutMs: SLOW }, async ($, on) => {
  let threshold = 950_000
  const usage = () => ({ context: { tokens: 484_000, window: 1_000_000, percent: 48, breakdown: {
    totalTokens: 484_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, percentage: 48, isAutoCompactEnabled: true, autoCompactThreshold: threshold, categories: [] } }, rateLimits: [], cost: { usd: 1.37 } })
  const h = setup(on, () => usage())
  await mainTurn($, h.step)
  const ui: any = await mount($)
  expect(await ui.find({ text: /^Auto-compact at 950k\. Try \/autocompact 400k\.$/ })).toBeDefined()
  const list = async () => String((await $.command.run({ command: 'tokens', args: 'list', presentation: { columns: 160 } })).text)
  expect(await list()).toContain('auto-compact at 950k on a 1M window: run /autocompact 400k')   // the help line under the table
  threshold = 400_000
  await h.clock.advance(2 * MIN)                                                 // past the breakdown cache
  expect(await list()).not.toContain('/autocompact 400k')
})
