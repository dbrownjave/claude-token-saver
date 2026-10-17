import { test, expect, mock } from 'claude-code/testing'

// VS Code (extension 2.1.301 on): surface 'vscode', Box Text Button Svg and no Raster or Client. It draws the band
// above the prompt and always places panes: inline under 800 px (isFullscreen false), docked beside the chat above it.
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
const BAND = { hasSurvey: false, bodyColumns: 78 }
const NARROW = { columns: 78, rows: 40, isFullscreen: false }
const PANE = { title: 'Context', isFocused: true, bodyColumns: 78, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const USAGE = { context: { tokens: 120_000, window: 200_000, percent: 60 }, rateLimits: [], cost: { usd: 0.9 } }
const STEP = { input_tokens: 2_000, cache_read_input_tokens: 110_000, cache_creation_input_tokens: 8_000, output_tokens: 300 }
const OPTIONS = { suggestSkills: false }

async function afterOneReply($: any, on: any, open: (e: any) => any = () => ({ isPlaced: true })) {
  mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const seen = { opened: [] as any[], toasts: [] as string[] }
  on('session.usage' as any, () => ({ value: USAGE }))
  on('ui.open' as any, (_$: any, e: any) => { seen.opened.push(e); return { value: open(e) } })
  on('ui.close' as any, () => ({ value: undefined }))
  on('ui.toast' as any, (_$: any, e: any) => { seen.toasts.push(String(e.text ?? e.message ?? e)); return { value: undefined } })
  for (const ev of ['ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))
  on('turn.step' as any, async function* () {
    return { turnId: 't', index: 0, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: STEP }
  })
  on('ui.render' as any, (_$: any, e: any) => { const { Box } = _$.ui.resolve(e); return Box({}) })
  const s = $.turn.step({ turnId: 't', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })
  for await (const _ of s) { /* drain */ }
  await s.result
  return seen
}
const band = ($: any, viewport: any = NARROW) =>
  $.ui.mount({ plugin: 'token-saver', surface: 'vscode', component: 'AbovePrompt', props: BAND, viewport })
const pane = ($: any, requestId = 'context') =>
  $.ui.mount({ plugin: 'token-saver', surface: 'vscode', component: 'Pane', requestId, props: PANE, viewport: NARROW })

test('vscode: the band draws the closed frame with Svg bars, never a Raster', { options: OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  await afterOneReply($, on)
  const ui: any = await band($)
  expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('More')
  expect(await ui.find({ key: 'ctx-clear' })).toBeDefined()
  expect(await ui.find({ key: 'ctx-compact' })).toBeDefined()
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(await ui.find({ type: 'Raster' })).toBeUndefined()
  await ui.unmount()
})

test('vscode: ⤢ is offered in a narrow panel too, since VS Code always places panes', { options: OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const seen = await afterOneReply($, on)
  const ui: any = await band($)
  await ui.press({ key: 'ctx-expand' })
  expect((await ui.find({ key: 'ctx-popout' }))?.props.label).toBe('⤢')
  await ui.press({ key: 'ctx-popout' })
  expect(seen.opened.map((o) => o.id)).toEqual(['context'])
  expect((await ui.find({ key: 'ctx-expand' }))?.props.label).toBe('More')                    // the band folds back
  await ui.unmount()
})

test('vscode: /tokens opens the Pane in full and leaves the band closed, so it is not drawn twice', { options: OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const seen = await afterOneReply($, on)
  await (await band($)).unmount()                                                            // the band has drawn on vscode
  const r: any = await $.command.run({ command: 'tokens', args: '', presentation: { isFullscreen: false, columns: 78 } } as any)
  expect(String(r.text)).toContain('Context pane opened')
  expect(seen.opened.map((o) => o.id)).toEqual(['context'])
  const b: any = await band($)
  expect((await b.find({ key: 'ctx-expand' }))?.props.label).toBe('More')
  expect(await b.find({ text: /^Claude's working memory$/ })).toBeUndefined()
  await b.unmount()
  const p: any = await pane($)
  expect(await p.find({ text: /^Claude's working memory$/ })).toBeDefined()                 // open in full
  expect(await p.find({ key: 'ctx-expand' })).toBeUndefined()
  expect(await p.find({ type: 'Svg' })).toBeDefined()
  expect(await p.find({ type: 'Raster' })).toBeUndefined()
  await p.unmount()
})

test('vscode: /tokens settings opens the side panel even in a narrow panel, not the band', { options: OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const seen = await afterOneReply($, on)
  await (await band($)).unmount()
  const r: any = await $.command.run({ command: 'tokens', args: 'settings', presentation: { isFullscreen: false, columns: 78 } } as any)
  expect(String(r.text)).toContain('Settings opened')
  expect(seen.opened.map((o) => o.id)).toEqual(['settings'])
  const b: any = await band($)
  expect(await b.find({ key: 'set-theme:light' })).toBeUndefined()
  await b.unmount()
  const p: any = await pane($, 'settings')
  expect(await p.find({ key: 'set-theme:light' })).toBeDefined()
  expect(await p.find({ text: /Auto is dark there/ })).toBeDefined()
  await p.unmount()
})

test('no surface attached (an older VS Code panel, an SDK host): /tokens answers in text, with no raw reason', { options: OPTIONS, timeoutMs: 30_000 }, async ($, on) => {
  const seen = await afterOneReply($, on, () => ({ isPlaced: false, reason: 'no-surface: no surface is attached ($.session.surfaces() is empty)' }))
  const r: any = await $.command.run({ command: 'tokens', args: '', presentation: { columns: 80 } } as any)
  expect(String(r.text)).toContain('Context')
  expect(String(r.text)).not.toContain('pane opened')
  expect(seen.toasts.join('\n')).not.toContain('no-surface')
  const s: any = await $.command.run({ command: 'tokens', args: 'settings', presentation: { columns: 80 } } as any)
  expect(String(s.text)).toContain('token-saver settings')
  expect(seen.toasts.join('\n')).not.toContain('no-surface')
})
