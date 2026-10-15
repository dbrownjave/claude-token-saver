import { test, expect, mock } from 'claude-code/testing'

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const BAND = { hasSurvey: false, bodyColumns: 78 }
const USAGE = { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], cost: { usd: 0.9 } }
const STEP = { input_tokens: 2_000, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 8_000, output_tokens: 300 }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band on ${surface}: one row with Open × on the terminal, design/m4.html's closed frame on the desktop`, { options: { suggestSkills: false }, timeoutMs: 30_000 }, async ($, on) => {
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
    if (surface === 'terminal') {
      // one row: bar, percent, cache words, saved, Open ×
      expect((await ui.find({ text: /^[ \u00a0]?60%$/ }))?.props.color).toBe('claude')          // past handoff: Claude orange
      expect(await ui.find({ text: /^Very warm 5m$/ })).toBeDefined()
      expect(await ui.find({ text: /^Reuses 120k$/ })).toBeDefined()
      expect(await ui.find({ type: 'Raster', key: 'ctx-bar' })).toBeDefined()
      expect(await ui.find({ text: /saved$/ })).toBeDefined()
      expect(await ui.find({ text: /^Past your handoff mark \(60%\)/ })).toBeDefined()     // the hint, on its own line
      expect(await ui.find({ text: /turn/i })).toBeUndefined()
      const open = await ui.find({ key: 'band-open' }), hide = await ui.find({ key: 'hide' })
      expect(open?.props.label).toBe('Open')
      expect(hide?.props.label).toBe('×')
      expect(hide?.props.role).toBe('dismiss')
      await ui.press({ key: 'band-open' })
      expect(opened.map((o) => o.id)).toContain('context')
      await ui.press({ key: 'hide' })
      expect(await ui.find({ key: 'band-open' })).toBeUndefined()
    } else {
      // design/m4.html's closed frame: Context and its figures, ? More; the bar; the cache and saved, Clear Compact Later
      expect(await ui.find({ text: /^Context$/ })).toBeDefined()
      expect(await ui.find({ key: 'band-open' })).toBeUndefined()
      expect(await ui.find({ key: 'hide' })).toBeUndefined()
      expect((await ui.findAll({ type: 'Svg' })).some((x: any) => /^Context 60%$/.test(String(x.props.alt)))).toBe(true)   // the bar, full width
      // 78 columns: the whole cache sentence would crowd the buttons, so the short words, on one line
      expect(await ui.find({ text: /^Very[ \u00a0]warm[ \u00a0]5m$/ })).toBeDefined()
      expect(await ui.find({ text: /Cache[ \u00a0]very[ \u00a0]warm/ })).toBeUndefined()
      for (const x of await ui.findAll({ type: 'Text', text: /saved$/ })) expect(x.props.wrap).toBe('truncate')
      const wide: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface, component: 'AbovePrompt', props: { ...BAND, bodyColumns: 140 } as any })
      expect(await wide.find({ text: /Cache[ \u00a0]very[ \u00a0]warm/ })).toBeDefined()      // room: the whole sentence (no-break spaces on the desktop)
      await wide.unmount()
      for (const k of ['ctx-explain', 'ctx-expand', 'ctx-clear', 'ctx-compact', 'ctx-later']) {
        const b = await ui.find({ key: k })
        expect(b).toBeDefined()
        expect(b?.props.plain).toBeUndefined()                           // native buttons, like the app's banners
      }
      expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('More')
      expect(await ui.find({ key: 'ctx-popout' })).toBeUndefined()        // closed: no ⤢, as the design
      expect(await ui.find({ text: /^Claude's working memory$/ })).toBeUndefined()
      // More opens M4's body in place (the desktop draws no plugin panes); Less folds it back
      await ui.press({ key: 'ctx-expand' })
      expect(await ui.find({ text: /^Claude's working memory$/ })).toBeDefined()
      expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('Less')
      expect(opened).toHaveLength(0)
      await ui.press({ key: 'ctx-expand' })
      expect(await ui.find({ text: /^Claude's working memory$/ })).toBeUndefined()
      // Later on the closed frame puts the band away
      await ui.press({ key: 'ctx-later' })
      expect(await ui.find({ key: 'ctx-expand' })).toBeUndefined()
    }
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

/** One reply in, so the band has figures; returns what ui.open, fs.write and process.run were asked. */
async function afterOneReply($: any, on: any) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const seen = { clock, redraws: 0, opened: [] as any[], writes: [] as any[], runs: [] as string[][] }
  on('ui.invalidate' as any, (_$: any, e: any, next: any) => { seen.redraws += 1; return typeof next === 'function' ? next(e) : { value: undefined } })
  on('session.usage' as any, () => ({ value: USAGE }))
  on('ui.open' as any, (_$: any, e: any) => { seen.opened.push(e); return { value: { isPlaced: true } } })
  on('fs.write' as any, (_$: any, e: any) => { seen.writes.push(e); return { value: undefined } })
  on('process.run' as any, (_$: any, e: any) => {
    seen.runs.push(e.argv)
    return { value: { exitCode: 0, stdout: e.argv[0] === 'uname' ? 'Darwin\n' : '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('turn.step' as any, async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: STEP }
  })
  for (const ev of ['ui.toast', 'ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))
  on('ui.render' as any, (_$: any, e: any) => { const { Box } = _$.ui.resolve(e); return Box({}) })
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
  for await (const _ of s) { /* drain */ }
  await s.result
  return seen
}

test('desktop: More opens the band in place, even on a surface that places panes', { options: { suggestSkills: false }, timeoutMs: 30_000 }, async ($, on) => {
  const seen = await afterOneReply($, on)
  const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'AbovePrompt', props: BAND as any, viewport: { columns: 120, rows: 40, isFullscreen: true } })
  await ui.press({ key: 'ctx-expand' })
  expect(seen.opened).toHaveLength(0)
  expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('Less')
  expect(await ui.find({ text: /^Claude's working memory$/ })).toBeDefined()
  await ui.unmount()
})

test('desktop: ⤢ opens the Context pane and folds the band back, where the surface places panes', { options: { suggestSkills: false }, timeoutMs: 30_000 }, async ($, on) => {
  const seen = await afterOneReply($, on)
  const flat: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'AbovePrompt', props: BAND as any })
  await flat.press({ key: 'ctx-expand' })
  expect(await flat.find({ key: 'ctx-popout' })).toBeUndefined()                            // no panes here: no button
  await flat.press({ key: 'ctx-expand' })
  await flat.unmount()
  const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'AbovePrompt', props: BAND as any, viewport: { columns: 120, rows: 40, isFullscreen: true } })
  await ui.press({ key: 'ctx-expand' })
  expect((await ui.find({ key: 'ctx-popout' }))?.props.label).toBe('⤢')
  await ui.press({ key: 'ctx-popout' })
  expect(seen.opened.map((o) => o.id)).toEqual(['context'])
  expect(seen.writes.find((w) => /token-saver-context\.html$/.test(w.path))).toBeUndefined()   // no browser page any more
  expect(seen.runs.find((r) => r[0] === 'open')).toBeUndefined()
  expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('More')                    // the band folds back
  expect(await ui.find({ text: /^Claude's working memory$/ })).toBeUndefined()                // not also in the band
  await ui.unmount()
  // the Pane it opened: always open, so no More / Less and no second ⤢
  const pane: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'Pane', requestId: 'context', props: { title: 'Context', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } })
  expect(await pane.find({ key: 'ctx-expand' })).toBeUndefined()
  expect(await pane.find({ key: 'ctx-popout' })).toBeUndefined()
  expect(await pane.find({ text: /^Claude's working memory$/ })).toBeDefined()                // open from the start
  await pane.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band on ${surface} ${surface === 'desktop' ? 'stands still, so a click is not lost to a redraw' : 'keeps its bar burning'}`, { options: { suggestSkills: false }, timeoutMs: 30_000 }, async ($, on) => {
    on('session.start' as any, (_$: any, e: any) => ({ cwd: e.cwd }))
    const seen = await afterOneReply($, on)
    await ($ as any).session.start({ cwd: '/tmp/x', surface: null, isInteractive: true })   // starts the 70 ms ticker
    const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface, component: 'AbovePrompt', props: BAND as any })
    seen.redraws = 0
    for (let i = 0; i < 20; i++) await seen.clock.advance(70)         // 1.4 s of ticks
    if (surface === 'desktop') expect(seen.redraws).toBe(0)
    else expect(seen.redraws).toBeGreaterThan(5)
    await ui.unmount()
  })
}
