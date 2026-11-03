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

const SHARED = ['set-cardBars:fire', 'set-cardBars:ember', 'set-cacheBand', 'set-compactHint', 'set-longCacheTtl', 'set-keepWarm', 'set-compactGuard', 'set-modelGuard', 'set-quietBash', 'set-trimOutput', 'set-suggestSkills', 'settings-done']
const walk = (n: any, out: any[] = []) => { if (!n || typeof n !== 'object') return out; out.push(n); (n.children || []).forEach((k: any) => walk(k, out)); return out }
const SUBSCRIPTION = { context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 12 }, { kind: 'seven_day', percentUsed: 14 }], cost: { usd: 1 } }
const API = { context: { tokens: 1000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 1 } }

test('settings panel on terminal: every option has a control, and a press saves it to /config', { options: OPTIONS }, async ($, on) => {
  const log = setup(on)
  const ui: any = await mount($, 'terminal')
  for (const k of [...SHARED, 'set-theme:auto', 'set-theme:dark', 'set-theme:light', 'set-keepWarmPings:up', 'set-inputPricePerM:up']) expect(await ui.find({ key: k })).toBeDefined()
  expect(await ui.find({ text: /Auto is dark there/ })).toBeDefined()

  await ui.press({ key: 'set-theme:light' })
  expect(log.sets).toContainEqual({ key: 'token-saver.theme', value: 'light' })

  expect((await ui.find({ key: 'set-keepWarm' }))?.props.label).toBe('━━━●')
  await ui.press({ key: 'set-keepWarm' })
  expect(log.sets).toContainEqual({ key: 'token-saver.keepWarm', value: false })
  expect((await ui.find({ key: 'set-keepWarm' }))?.props.label).toBe('●━━━')

  await ui.press({ key: 'set-keepWarmPings:up' })
  expect(log.sets).toContainEqual({ key: 'token-saver.keepWarmPings', value: 6 })
  expect(await ui.find({ type: 'Text', text: /^6$/ })).toBeDefined()

  await ui.press({ key: 'settings-done' })
  expect(log.closed.map((c) => c.id)).toContain('settings')
})

test('settings panel on terminal: no bold bracket Button and no Svg, the active value in orange', { options: OPTIONS }, async ($, on) => {
  setup(on)
  const ui: any = await mount($, 'terminal')
  const nodes = walk(await ui.drawn())
  const buttons = nodes.filter((n) => n.type === 'Button')
  expect(buttons.length).toBeGreaterThan(13)
  for (const b of buttons) expect(b.props.plain).toBe(true)
  expect(nodes.some((n) => n.type === 'Svg')).toBe(false)
  expect(nodes.some((n) => n.props?.bold)).toBe(false)
  const auto = await ui.find({ key: 'set-theme:auto' })
  expect(auto.children[0].props.color).toBe('claude')
  expect((await ui.find({ key: 'set-theme:dark' })).props.dimColor).toBe(true)
})

test('settings panel on desktop: a switch that presses, dropdowns for the longer lists, a press saves it to /config', { options: OPTIONS }, async ($, on) => {
  const log = setup(on)
  const ui: any = await mount($, 'desktop')
  for (const k of [...SHARED, 'set-theme', 'set-keepWarmPings', 'set-inputPricePerM']) expect(await ui.find({ key: k })).toBeDefined()
  expect(await ui.find({ text: /Auto is dark there/ })).toBeDefined()

  await ui.select({ key: 'set-theme', value: 'light' })
  expect(log.sets).toContainEqual({ key: 'token-saver.theme', value: 'light' })
  expect((await ui.find({ type: 'Text', text: /^Settings$/ }))?.props.color).toBe('#141413')   // the light palette, before the reload

  const alts = async () => walk(await ui.drawn()).filter((n) => n.type === 'Svg' && n.props.alt !== 'divider').map((n) => n.props.alt)
  expect((await alts()).filter((x) => x.endsWith(': On')).length).toBeGreaterThan(5)
  expect(await alts()).toContain('Keep the cache warm while idle: On')
  await ui.press({ key: 'set-keepWarm' })
  expect(log.sets).toContainEqual({ key: 'token-saver.keepWarm', value: false })
  expect(await alts()).toContain('Keep the cache warm while idle: Off')

  await ui.select({ key: 'set-keepWarmPings', value: '6' })
  expect(log.sets).toContainEqual({ key: 'token-saver.keepWarmPings', value: 6 })

  await ui.press({ key: 'settings-done' })
  expect(log.closed.map((c) => c.id)).toContain('settings')
})

for (const bodyColumns of [100, 40]) {
  test(`a switch shows no word, is long, and presses, at ${bodyColumns} columns`, { options: OPTIONS }, async ($, on) => {
    const log = setup(on)
    const props = { ...PANE, bodyColumns }
    const desk: any = await mount($, 'desktop', props)
    const nodes = walk(await desk.drawn())
    for (const key of ['set-cacheBand', 'set-quietBash', 'set-suggestSkills']) {
      const b = await desk.find({ key })
      expect(b.props.label.replace(/\u00a0/g, '')).toBe('')
      // 11 spaces measured 53 px in the app against a 40 px pill, and a plain Button's hover fill showed past its end. 6 stays inside.
      expect(b.props.label.length).toBe(6)
      expect(b.children ?? []).toEqual([])
    }
    expect(nodes.some((n) => n.props?.color === 'transparent')).toBe(false)
    const sw = nodes.filter((n) => n.type === 'Svg' && n.props.alt !== 'divider')
    expect(sw.length).toBe(9)
    for (const s of sw) { expect(s.props.width).toBe(40); expect(s.props.height).toBe(20) }
    const over = nodes.filter((n) => n.type === 'Box' && n.props.position === 'absolute')
    expect(over.length).toBe(9)
    for (const b of over) { expect(b.props.left).toBe(0); expect(b.props.right).toBe(0); expect(b.props.justifyContent).toBe('center') }
    expect(await desk.find({ type: 'Text', text: /^(On|Off)$/ })).toBeUndefined()
    await desk.press({ key: 'set-quietBash' })
    expect(log.sets).toContainEqual({ key: 'token-saver.quietBash', value: false })

    const term: any = await mount($, 'terminal', props)
    expect(await term.find({ type: 'Text', text: /^(On|Off)$/ })).toBeUndefined()
    expect((await term.find({ key: 'set-cacheBand' })).props.label).toBe('━━━●')
    await term.press({ key: 'set-cacheBand' })
    expect(log.sets).toContainEqual({ key: 'token-saver.cacheBand', value: false })
    expect((await term.find({ key: 'set-cacheBand' })).props.label).toBe('●━━━')
  })
}

test('settings panel in VS Code: the same switch and dropdowns', { options: OPTIONS }, async ($, on) => {
  setup(on)
  const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface: 'vscode', component: 'Pane', requestId: 'settings', props: PANE })
  expect(await ui.find({ key: 'set-theme' })).toBeDefined()
  expect(await ui.find({ key: 'set-keepWarm' })).toBeDefined()
})

test('a refused change goes back and says why, above the card', { options: OPTIONS }, async ($, on) => {
  setup(on, { refuse: 'locked by your organization' })
  const ui: any = await mount($, 'desktop')
  await ui.press({ key: 'set-quietBash' })
  expect(walk(await ui.drawn()).filter((n) => n.type === 'Svg').map((n) => n.props.alt)).toContain('Rewrite noisy bash: On')
  expect(await ui.find({ text: /^Rewrite noisy bash not saved: locked by your organization$/ })).toBeDefined()
  const nodes = walk(await ui.drawn())
  const msg = nodes.findIndex((n) => n.type === 'Text' && /not saved/.test(n.children?.[0] ?? ''))
  const firstControl = nodes.findIndex((n) => n.props?.key === 'set-theme')
  expect(msg).toBeGreaterThan(-1)
  expect(msg).toBeLessThan(firstControl)
})

test('on a subscription the rows that do nothing say so, and the switch keeps its knob without the colour', { options: OPTIONS }, async ($, on) => {
  setup(on)
  on('session.usage' as any, () => ({ value: SUBSCRIPTION }))
  const ui: any = await mount($, 'terminal')
  expect(await ui.find({ text: /^Off \(not API billing\): a subscription caches for an hour already\.$/ })).toBeDefined()
  expect(await ui.find({ text: /^Off: follows Claude Code's cache, now 1 hour from your plan\.$/ })).toBeDefined()
  expect(await ui.find({ text: /Not used while keep-warm is off/ })).toBeDefined()
  expect(await ui.find({ text: /^Not used on a subscription/ })).toBeDefined()
  const keepWarm = await ui.find({ key: 'set-keepWarm' })
  expect(keepWarm.props.label).toBe('━━━●')
  expect(keepWarm.children[0].props.color).toBe('inactive')
  expect((await ui.find({ key: 'set-quietBash' })).children[0].props.color).toBe('claude')
})

test('on an API key keep-warm is in force and says what it does', { options: OPTIONS }, async ($, on) => {
  setup(on)
  on('session.usage' as any, () => ({ value: API }))
  const ui: any = await mount($, 'terminal')
  expect(await ui.find({ text: /^API billing on the 5-minute cache only\./ })).toBeDefined()
  expect(await ui.find({ text: /^Off: follows Claude Code's cache, now 5 minutes\.$/ })).toBeDefined()
  expect((await ui.find({ key: 'set-keepWarm' })).children[0].props.color).toBe('claude')
})

test('settings panel at 40 columns: no box wider than the panel, and every label fits beside its control', { options: OPTIONS }, async ($, on) => {
  setup(on)
  const ui: any = await mount($, 'desktop', { ...PANE, bodyColumns: 40 })
  for (const b of walk(await ui.drawn()).filter((n) => n.type === 'Box')) if (typeof b.props?.width === 'number') expect(b.props.width).toBeLessThanOrEqual(40)
  expect(await ui.find({ key: 'set-theme' })).toBeDefined()
  // the terminal's card leaves 36 cells at 40: the longest label and its widest control must fit, or a word gets cut
  const term: any = await mount($, 'terminal', { ...PANE, bodyColumns: 40 })
  const texts = walk(await term.drawn()).filter((n) => n.type === 'Text').map((n) => String(n.children?.[0] ?? ''))
  expect(texts).toContain('Input $ per million tokens')
  expect('Input $ per million tokens'.length + 1 + '− $0.80 +'.length).toBeLessThanOrEqual(36)
  expect('Suggest parked skills at start'.length + 1 + '━━━●'.length).toBeLessThanOrEqual(36)
  expect('Palette'.length + 1 + 'Auto Dark Light'.length).toBeLessThanOrEqual(36)
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
  expect(await ui.find({ key: 'set-theme' })).toBeDefined()
  await ui.press({ key: 'settings-done' })
  expect(await (await band()).find({ key: 'set-theme' })).toBeUndefined()
})


test('settings copy says no "TTL" and no "0 turns"', { options: OPTIONS }, async ($, on) => {
  setup(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui: any = await mount($, surface)
    const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => String(t.children?.[0] ?? ''))
    expect(texts.some((t: string) => /\bTTL\b|0 turns/.test(t))).toBe(false)
    expect(texts).toContain('About 4 minutes apart. At 0 it sends none.')
    await ui.unmount()
  }
})
