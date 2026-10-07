import { test, expect, mock } from 'claude-code/testing'

const TOOL = 'mcp__token-saver__progress'
const BAND = { hasSurvey: false, bodyColumns: 100 }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`progress tool draws an eased row with a pill and a close button on ${surface}`, async ($, on) => {
    mock.clock(on)
    mock.store(on)
    mock.env(on, { HOME: '/nonexistent-home' })
    // The engine draws a transcript row for a tool call; stand in for it beneath the plugin.
    on('ui.render' as any, (_$: any, e: any) => {
      const { Box } = _$.ui.resolve(e)
      return Box({})
    })
    on('ui.status' as any, () => ({ value: undefined }))
    const r: any = await ($ as any).tool.call({ tool: TOOL, id: 'rel', label: 'Release pipeline', stage: 'Build', step: 2, total: 3 })
    expect(r.result.content[0].text).toContain('Release pipeline')
    expect(r.result.content[0].text).toContain('Build 2/3')
    const ui: any = await ($ as any).ui.mount({ plugin: 'token-saver', surface, component: 'AbovePrompt', props: BAND as any })
    expect(await ui.find({ text: /Release pipeline/ })).toBeDefined()
    expect(await ui.find({ key: 'progress-close:rel' })).toBeDefined()
    if (surface === 'desktop') {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg).toBeDefined()
      expect(String(svg.props.source)).toContain('Build 2/3')
    } else {
      expect(await ui.find({ text: /Build 2\/3/ })).toBeDefined()
    }
    const done: any = await ($ as any).tool.call({ tool: TOOL, id: 'rel', state: 'done' })
    expect(done.result.content[0].text).toContain('100%')
    await ui.press({ key: 'progress-close:rel' })
    expect(await ui.find({ key: 'progress-close:rel' })).toBeUndefined()
    const gone: any = await ($ as any).tool.call({ tool: TOOL, id: 'rel', remove: true })
    expect(gone.result.content[0].text).toContain('removed')
  })
}
