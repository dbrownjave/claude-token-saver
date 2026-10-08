import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)
const PANE = { title: 'Context', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

const USAGE = {
  startedAt: NOW - 2 * 3600 * 1000,
  context: {
    tokens: 484_000, window: 1_000_000, percent: 48,
    breakdown: {
      categories: [
        { name: 'System prompt', tokens: 8_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'System tools', tokens: 3_000, color: 'promptBorder', isDeferred: false, kind: 'used' },
        { name: 'MCP tools', tokens: 63_000, color: 'permission', isDeferred: false, kind: 'used' },
        { name: 'Memory files', tokens: 20_000, color: 'success', isDeferred: false, kind: 'used' },
        { name: 'Skills', tokens: 88_000, color: 'success', isDeferred: false, kind: 'used' },
        { name: 'Messages', tokens: 302_000, color: 'warning', isDeferred: false, kind: 'used' },
        { name: 'Free space', tokens: 486_000, color: 'inactive', isDeferred: false, kind: 'free' },
        { name: 'Autocompact buffer', tokens: 30_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
      ],
      totalTokens: 484_000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'auto', percentage: 48,
      gridRows: [], model: 'Fable 5.1', memoryFiles: [], mcpTools: [], agents: [],
      autoCompactThreshold: 970_000, isAutoCompactEnabled: true, apiUsage: null,
    },
  },
  rateLimits: [],
  cost: { usd: 1.37 },
}

function wire(on: any, usageArgs: any[], closed: string[], compacts: any[], commands: any[]) {
  on('session.usage' as any, (_$: any, e: any) => { usageArgs.push(e); return { value: USAGE } })
  on('ui.close' as any, (_$: any, e: any) => { closed.push(e.id); return { value: undefined } })
  on('ui.toast' as any, () => ({ value: undefined }))
  on('ui.status' as any, () => ({ value: undefined }))
  on('session.compact' as any, (_$: any, e: any) => { compacts.push(e); return { messages: [{ role: 'assistant', text: 'summary', toolUses: [] }], tokensBefore: 484_000, tokensAfter: 120_000 } })
  on('command.run' as any, (_$: any, e: any) => { commands.push(e); return { text: 'cleared' } })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`context pane: our bar, one-hue legend, cache + saved cards, Clear / Compact / Later on ${surface}`, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    mock.env(on, { HOME: '/nonexistent-home' })
    const usageArgs: any[] = [], closed: string[] = [], compacts: any[] = [], commands: any[] = []
    wire(on, usageArgs, closed, compacts, commands)
    const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface, component: 'Pane', requestId: 'context', props: PANE as any })

    expect(usageArgs.length).toBeGreaterThan(0)
    expect(usageArgs[0].breakdown).toBe('summary')          // never 'full'
    expect(await ui.find({ text: /^Context window$/ })).toBeDefined()
    expect(await ui.find({ text: /484k \/ 1M \(48%\)/ })).toBeDefined()
    expect(await ui.find({ key: 'ctx-clear' })).toBeUndefined()        // collapsed: headline + bar only
    await ui.press({ key: 'ctx-expand' })
    expect(await ui.find({ text: /^Cache$/ })).toBeDefined()
    expect(await ui.find({ text: /^0 tok$/ })).toBeDefined()                       // nothing saved yet
    expect(await ui.find({ text: /0 quiet commands · 0 cold compacts vetoed/ })).toBeDefined()
    expect(await ui.find({ text: /set \$\/M in \/config for dollars/ })).toBeDefined()   // cost ledger present but no turns: no derived rate yet
    expect(await ui.find({ text: /\$1\.37 spent/ })).toBeDefined()
    expect(await ui.find({ text: /Where tokens go/ })).toBeDefined()
    expect(await ui.find({ text: /^MCP tools $/ })).toBeDefined()
    expect(await ui.find({ text: /^Messages $/ })).toBeDefined()
    expect(await ui.find({ text: /next mark 60% \(handoff\)/ })).toBeDefined()
    expect(await ui.find({ text: /no response yet/ })).toBeDefined()

    if (surface === 'desktop') {
      const svgs = await ui.findAll({ type: 'Svg' })
      expect(svgs.length).toBe(1)                            // the split context bar; the cache bar waits for a first response
      expect(String(svgs[0].props.source)).toContain('48%')       // the pill
    } else {
      expect(await ui.find({ type: 'Raster' })).toBeDefined()
    }

    const clear = await ui.find({ key: 'ctx-clear' }), compact = await ui.find({ key: 'ctx-compact' }), later = await ui.find({ key: 'ctx-later' })
    expect(clear?.props.hotkey).toBe('c')
    expect(compact?.props.hotkey).toBe('k')
    expect(later?.props.hotkey).toBe('l')

    await ui.press({ key: 'ctx-compact' })
    expect(compacts.length).toBe(1)
    await ui.press({ key: 'ctx-clear' })
    expect(commands[0]?.command).toBe('clear')
    expect(closed).toContain('context')
    await ui.press({ key: 'ctx-later' })
    expect(closed.filter((id) => id === 'context').length).toBeGreaterThanOrEqual(2)
  })
}

test('context pane without a breakdown falls back to one Used entry and no tick', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  on('session.usage' as any, () => ({ value: { startedAt: NOW, context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [] } }))
  on('ui.close' as any, () => ({ value: undefined }))
  const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'Pane', requestId: 'context', props: PANE as any })
  expect(await ui.find({ text: /120k \/ 200k \(60%\)/ })).toBeDefined()
  await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /Compact at/ })).toBeUndefined()
  expect(await ui.find({ text: /tokens only/ })).toBeDefined()                     // no cost ledger, no rate limits: unknown billing
  expect(await ui.find({ text: /next mark 75% \(compact\)/ })).toBeDefined()
})

test('context pane on a subscription prices savings as window headroom once the window moves', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  on('session.usage' as any, () => ({ value: { startedAt: NOW, context: { tokens: 300_000, window: 1_000_000, percent: 30 }, rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: new Date(NOW + 3600_000).toISOString() }] } }))
  on('ui.close' as any, () => ({ value: undefined }))
  const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'Pane', requestId: 'context', props: PANE as any })
  await ui.press({ key: 'ctx-expand' })
  expect(await ui.find({ text: /40% of 5-hour window used/ })).toBeDefined()
  expect(await ui.find({ text: /subscription: window maths appears once the 5-hour window moves/ })).toBeDefined()
  expect(await ui.find({ text: /\$/ })).toBeUndefined()                           // never a dollar on a subscription
})
