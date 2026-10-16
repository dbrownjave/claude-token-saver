import { test, expect, mock } from 'claude-code/testing'

const PANE = { title: 'Token-saver settings', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }
const OPTIONS = { suggestSkills: false }

function setup(on: any, opts: { refuse?: string } = {}) {
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const log = { sets: [] as any[], opened: [] as any[], closed: [] as any[] }
  on('config.set' as any, (_$: any, e: any) => {
    if (e.key && String(e.key).startsWith('token-saver.')) log.sets.push({ key: e.key, value: e.value })
    if (opts.refuse) return { deny: opts.refuse }
    return { value: e.value }
  })
  on('ui.open' as any, (_$: any, e: any) => { log.opened.push(e); return { value: { isPlaced: true } } })
  on('ui.close' as any, (_$: any, e: any) => { log.closed.push(e); return { value: undefined } })
  on('ui.render' as any, (_$: any, e: any) => { const { Box } = _$.ui.resolve(e); return Box({}) })
  for (const ev of ['ui.toast', 'ui.status', 'ui.log']) on(ev as any, () => ({ value: undefined }))
  return log
}
const mount = ($: any, surface: 'terminal' | 'desktop', props: any = PANE) =>
  $.ui.mount({ plugin: 'token-saver', surface, component: 'Pane', requestId: 'settings', props })

for (const surface of ['terminal', 'desktop'] as const) {
  test(`settings panel on ${surface}: every option has a control, and a press saves it to /config`, { options: OPTIONS }, async ($, on) => {
    const log = setup(on)
    const ui: any = await mount($, surface)
    for (const k of ['set-theme:auto', 'set-theme:dark', 'set-theme:light', 'set-cardBars:ember', 'set-cacheBand', 'set-compactHint', 'set-longCacheTtl',
      'set-keepWarm', 'set-keepWarmPings:up', 'set-compactGuard', 'set-modelGuard', 'set-quietBash', 'set-trimOutput', 'set-suggestSkills', 'set-inputPricePerM:up', 'settings-done']) {
      expect(await ui.find({ key: k })).toBeDefined()
    }
    expect((await ui.find({ key: 'set-theme:auto' }))?.props.variant).toBe('primary')
    expect(await ui.find({ text: /Auto is dark there/ })).toBeDefined()

    await ui.press({ key: 'set-theme:light' })
    expect(log.sets).toContainEqual({ key: 'token-saver.theme', value: 'light' })
    expect((await ui.find({ key: 'set-theme:light' }))?.props.variant).toBe('primary')
    expect((await ui.find({ key: 'set-theme:auto' }))?.props.variant).toBeUndefined()
    if (surface === 'desktop') expect((await ui.find({ type: 'Text', text: /^Settings$/ }))?.props.color).toBe('#141413')   // the light palette, before the reload

    expect((await ui.find({ key: 'set-keepWarm' }))?.props.label).toBe('On')
    await ui.press({ key: 'set-keepWarm' })
    expect(log.sets).toContainEqual({ key: 'token-saver.keepWarm', value: false })
    expect((await ui.find({ key: 'set-keepWarm' }))?.props.label).toBe('Off')

    await ui.press({ key: 'set-keepWarmPings:up' })
    expect(log.sets).toContainEqual({ key: 'token-saver.keepWarmPings', value: 6 })
    expect(await ui.find({ text: /^[  ]6[  ]$/ })).toBeDefined()

    await ui.press({ key: 'settings-done' })
    expect(log.closed.map((c) => c.id)).toContain('settings')
  })
}

test('a refused change goes back and says why', { options: OPTIONS }, async ($, on) => {
  setup(on, { refuse: 'locked by your organization' })
  const ui: any = await mount($, 'desktop')
  await ui.press({ key: 'set-quietBash' })
  expect((await ui.find({ key: 'set-quietBash' }))?.props.label).toBe('On')
  expect(await ui.find({ text: /^Rewrite noisy bash not saved: locked by your organization$/ })).toBeDefined()
})

test('settings panel at 40 columns: no box wider than the panel, labels above their controls', { options: OPTIONS }, async ($, on) => {
  setup(on)
  const ui: any = await mount($, 'desktop', { ...PANE, bodyColumns: 40 })
  const boxes: any[] = []
  const walk = (n: any) => { if (!n || typeof n !== 'object') return; if (n.type === 'Box') boxes.push(n); (n.children || []).forEach(walk) }
  walk(await ui.drawn())
  for (const b of boxes) if (typeof b.props?.width === 'number') expect(b.props.width).toBeLessThanOrEqual(40)
  expect(await ui.find({ key: 'set-theme:light' })).toBeDefined()
})

test('/tokens settings opens the side panel where panes dock', { options: OPTIONS }, async ($, on) => {
  const log = setup(on)
  const r: any = await $.command.run({ command: 'tokens', args: 'settings', presentation: { isFullscreen: true, columns: 160 } } as any)
  expect(log.opened.map((o) => o.id)).toContain('settings')
  expect(String(r.text)).toContain('Settings opened')
})

test('a desktop that docks no panes shows Settings in the band, and Done puts them away', { options: OPTIONS }, async ($, on) => {
  const log = setup(on)
  const band = () => ($ as any).ui.mount({ plugin: 'token-saver', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } })
  await band()                                                   // the band has drawn on the desktop
  const r: any = await $.command.run({ command: 'tokens', args: 'settings', presentation: { isFullscreen: false, columns: 100 } } as any)
  expect(String(r.text)).toContain('above the prompt')
  expect(log.opened.length).toBe(0)
  const ui: any = await band()
  expect(await ui.find({ key: 'set-theme:light' })).toBeDefined()
  await ui.press({ key: 'settings-done' })
  expect(await (await band()).find({ key: 'set-theme:light' })).toBeUndefined()
})
