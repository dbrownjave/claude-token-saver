import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const BAND = { hasSurvey: false, bodyColumns: 78 }
const USAGE = { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], cost: { usd: 0.9 } }
const STEP = { input_tokens: 2_000, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 8_000, output_tokens: 300 }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band on ${surface}: fire bar, percent, cache words, saved, ⌄ opens the pane, × hides it`, { options: { suggestSkills: false }, timeoutMs: 30_000 }, async ($, on) => {
    mock.clock(on, { now: NOW })
    mock.store(on)
    mock.env(on, { HOME: '/nonexistent-home' })
    const opened: any[] = []
    on('session.usage' as any, () => ({ value: USAGE }))
    on('ui.open' as any, (_$: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
    on('turn.step' as any, async function* () {
      return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: STEP }
    })
    for (const ev of ['ui.toast', 'ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))
    on('ui.render' as any, (_$: any, e: any) => { const { Box } = _$.ui.resolve(e); return Box({}) })

    const ui0: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface, component: 'AbovePrompt', props: BAND as any })
    expect(await ui0.find({ key: 'band-open' })).toBeUndefined()        // nothing to show before the first reply
    await ui0.unmount()

    const s = ($ as any).turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
    for await (const _ of s) { /* drain */ }
    await s.result

    const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface, component: 'AbovePrompt', props: BAND as any })
    expect(await ui.find({ text: /^[ \u00a0]?60%$/ })).toBeDefined()
    expect((await ui.find({ text: /^[ \u00a0]?60%$/ }))?.props.color).toBe(surface === 'terminal' ? 'claude' : '#d97757')   // desktop gets the app's own colour value         // past handoff: Claude orange
    if (surface === 'terminal') {
      expect(await ui.find({ text: /^Warm 5m$/ })).toBeDefined()
      expect(await ui.find({ text: /^Reuses 120k$/ })).toBeDefined()
      expect(await ui.find({ type: 'Raster', key: 'ctx-bar' })).toBeDefined()
    } else {
      expect(await ui.find({ text: /^Cache warm: next message reuses[ \u00a0]$/ })).toBeDefined()
      expect(await ui.find({ text: /^120k$/ })).toBeDefined()
      expect((await ui.findAll({ type: 'Svg' })).length).toBeGreaterThanOrEqual(2)
    }
    expect(await ui.find({ text: /saved$/ })).toBeDefined()
    expect(await ui.find({ text: /^Past your handoff mark \(60%\)/ })).toBeDefined()     // the hint, on its own line
    expect(await ui.find({ text: /turn/i })).toBeUndefined()
    const open = await ui.find({ key: 'band-open' }), hide = await ui.find({ key: 'hide' })
    expect(open?.props.label).toBe('⌄')
    expect(hide?.props.label).toBe('×')
    for (const b of [open, hide]) expect(b?.props.bold).toBeUndefined()

    await ui.press({ key: 'band-open' })
    expect(opened.map((o) => o.id)).toContain('context')
    await ui.press({ key: 'hide' })
    expect(await ui.find({ key: 'band-open' })).toBeUndefined()
  })
}

test('the band drops "Reuses" first, then the bar, on a narrow terminal', { options: { suggestSkills: false }, timeoutMs: 30_000 }, async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  on('session.usage' as any, () => ({ value: USAGE }))
  on('turn.step' as any, async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: STEP }
  })
  for (const ev of ['ui.toast', 'ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))
  on('ui.render' as any, (_$: any, e: any) => { const { Box } = _$.ui.resolve(e); return Box({}) })
  const s = ($ as any).turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
  for await (const _ of s) { /* drain */ }
  await s.result
  let ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 56 } as any })
  expect(await ui.find({ text: /^Reuses/ })).toBeUndefined()
  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  await ui.unmount()
  ui = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 40 } as any })
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  expect(await ui.find({ text: /^60%$/ })).toBeDefined()
})
