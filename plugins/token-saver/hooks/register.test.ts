import { test, expect, mock } from 'claude-code/testing'

const BIG = 'x'.repeat(20_000)

test('quiet-bash rewrites git status and trims huge successful stdout', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  let seen = ''
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    seen = (e as any).command
    return { result: { stdout: BIG, stderr: '' } }
  })
  const r: any = await $.tool.call({ tool: 'Bash', command: 'git status' } as any)
  expect(seen).toBe('git status -sb')
  expect(r.result.stdout.length).toBeLessThan(5000)
  expect(r.result.stdout).toContain('token-saver trimmed')
})

test('failures are never trimmed', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: BIG, stderr: 'boom' } }))
  const r: any = await $.tool.call({ tool: 'Bash', command: 'ls -la' } as any)
  expect(r.result.stdout.length).toBe(BIG.length)
})

test('a plugin compaction gets the keep-list and is never vetoed', async ($, on) => {
  mock.clock(on)
  mock.env(on, { HOME: '/nonexistent-home' })
  const transcript = [{ role: 'user', text: 'hello', toolUses: [] }]
  let instructions = ''
  on('session.compact', (_$, e) => {
    instructions = (e as any).instructions || ''
    return { messages: [{ role: 'assistant', text: 'summary', toolUses: [] }] } as any
  })
  const r: any = await $.session.compact({ instructions: 'the plan', messages: transcript } as any)
  expect(r.skip).toBeUndefined()
  expect(instructions).toContain('the plan')
  expect(instructions).toContain('When compacting, keep')
})
