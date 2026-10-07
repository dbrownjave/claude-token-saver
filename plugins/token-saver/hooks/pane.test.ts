import { test, expect, mock } from 'claude-code/testing'

const STATUS = {
  active: [
    { name: 'plan', per_turn: 47, on_invoke: 320 },
    { name: 'floor-design-system', per_turn: 168, on_invoke: 1988 },
  ],
  parked: [
    { name: 'gsap-core', per_turn: 138, on_invoke: 900 },
    { name: 'gsap-react', per_turn: 72, on_invoke: 700 },
  ],
  usage: { plan: { count: 16, last: Date.now() / 1000 - 86400 }, 'gsap-react': { count: 1, last: Date.now() / 1000 - 7 * 86400 } },
  unused: ['floor-design-system'],
  project_links: ['gsap-react'],
  per_turn_tokens: 215,
  parked_tokens: 210,
  scan_note: 'usage from cache',
}

const PANE = { title: 'Loadout', isFocused: true, bodyColumns: 110, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`skills pane draws rows with Park / Link / Unpark on ${surface}`, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    mock.env(on, { HOME: '/nonexistent-home' })
    const calls: string[][] = []
    on('process.run' as any, (_$: any, e: any) => {
      calls.push(e.argv)
      return { value: { exitCode: 0, stdout: JSON.stringify(STATUS), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface, component: 'Pane', requestId: 'loadout', props: PANE as any })
    expect((await ui.find({ key: 'refresh' }))?.props.label).toBe('Refresh')
    await ui.press({ key: 'refresh' })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls[0].join(' ')).toContain('skills.py status --json')
    expect(await ui.find({ key: 'park:plan' })).toBeDefined()
    expect(await ui.find({ key: 'park:floor-design-system' })).toBeDefined()
    expect(await ui.find({ key: 'link:gsap-core' })).toBeDefined()
    expect(await ui.find({ key: 'unpark:gsap-core' })).toBeDefined()
    expect(await ui.find({ key: 'unlink:gsap-react' })).toBeDefined()
    expect((await ui.find({ key: 'park-unused' }))?.props.label).toBe('Park 1 unused')
    await ui.press({ key: 'park:floor-design-system' })
    const park = calls.find((c) => c.includes('park') && c.includes('floor-design-system'))
    expect(park).toBeDefined()
    // the action reported through a progress row in the band
    const band: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface, component: 'AbovePrompt', props: { hasSurvey: false, bodyColumns: 100 } as any })
    expect(await band.find({ key: 'progress-close:loadout' })).toBeDefined()
    expect(await band.find({ text: /Park 1 skill/ })).toBeDefined()
  })
}
