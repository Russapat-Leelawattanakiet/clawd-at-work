// Round 3 probe tests, written by the tester against REQUIREMENTS.md (R1.1-R7.4).
// A test named "BUG ..." or "IMPROVE ..." failed while the finding stood and
// passes once it is fixed.
import type { AgentStatus, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'clawd-at-work',
  component: 'Pane',
  requestId: 'clawd-at-work',
  surface: 'terminal',
  props: {
    title: 'Claude at work',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const
const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 80 } }

const SPAWN = {
  tool_use_id: 'tu1',
  prompt: 'look',
  description: 'find code',
  subagentType: 'Explore',
  provider: { plugin: 'engine', tier: 'user' },
  parentModel: 'test',
  background: true,
  fork: false,
} as const
const AGENT_END = { answer: '', durationMs: 5, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' } as const
const MAIN_END = { answer: '', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' } as const

// A store shared like the real one: one map every "session" of the test reads.
const sharedStore = (on: On, kept: Map<string, unknown>) => {
  on('store.get', (_: unknown, e: { key: string }) => ({ value: kept.get(e.key) }) as never)
  on('store.set', (_: unknown, e: { key: string; value: unknown }) => {
    kept.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_: unknown, e: { key: string }) => {
    kept.delete(e.key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...kept.keys()] }) as never)
}

// The engine stand-in of probe2.test.tsx, plus session.id 'me' and no git repo.
type Opts = { repo?: string; tool?: (e: Record<string, unknown>) => unknown }
const engine = (
  on: On,
  status: { now: AgentStatus } = { now: 'running' },
  kept = new Map<string, unknown>(),
  opts: Opts = {},
) => {
  const clock = mock.clock(on, { now: 1_000 })
  sharedStore(on, kept)
  let spawned = 0
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__clawd-at-work__plan' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.id', () => ({ value: 'me' }) as never)
  on('session.repo', () => ({ value: opts.repo ? { root: opts.repo, remote: null, internal: false } : null }) as never)
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => (opts.tool?.(e as never) ?? { result: {} }) as never)
  on('agent.spawn', () => ({ agentId: `a${++spawned}`, model: 'test' }))
  on('agent.list', () => ({
    value: Array.from({ length: spawned }, (_, i) => ({
      id: `a${i + 1}`,
      description: 'find code',
      type: 'Explore',
      status: i + 1 === spawned ? status.now : ('completed' as const),
    })),
  }))
  return clock
}

type T = Parameters<Parameters<typeof test>[1]>[0]
const startIn = ($: T, cwd: string) => $.session.start({ cwd, surface: 'terminal', isInteractive: true })
// Run the ticker for `ms` of fake time, a tick at a time.
const run = async (clock: { now: () => number; set: (t: number) => Promise<unknown> }, ms: number) => {
  const from = clock.now()
  for (let t = 250; t <= ms; t += 250) await clock.set(from + t)
}
const peer = (id: string, cwd: string, task: string, extra: Record<string, unknown> = {}) => ({
  id,
  cwd,
  task,
  state: 'working',
  activity: 'Running npm test',
  percent: 40,
  updatedAt: 1_000,
  ...extra,
})
const NOTICE = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>'

// Terminal columns, as Ink measures them (string-width): CJK, fullwidth and
// emoji two; an emoji presentation sequence (base + U+FE0F) two; combining
// marks and joiners none.
const WIDE_BMP = new Set([0x231a, 0x231b, 0x23f0, 0x23f3, 0x2614, 0x2615, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
  0x26c4, 0x26c5, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c,
  0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55])
const cols = (s: string) => {
  const chars = [...s]
  return chars.reduce((w, ch, i) => {
    const c = ch.codePointAt(0)!
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return w
    const isEmojiPresented = chars[i + 1] === '\ufe0f' && c >= 0x2000
    const wide =
      isEmojiPresented ||
      WIDE_BMP.has(c) ||
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x1f300 && c <= 0x1faff)
    return w + (wide ? 2 : 1)
  }, 0)
}

test('BUG R6.3/R2.1: a session whose task is in CJK keeps its percent in 40 columns', async ($, on) => {
  const kept = new Map<string, unknown>([['session:p1', peer('p1', '/r', 'ログインのバグを直してテストを追加する')]])
  const clock = engine(on, { now: 'running' }, kept)
  await startIn($, '/r')
  await run(clock, 2_500)
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /ログイン/ }))?.text ?? ''
  await ui.unmount()
  expect(cols(row)).toBeLessThanOrEqual(40)
  expect(row).toMatch(/40%$/)
})

test('IMPROVE R6.3: with more than four other sessions, the working ones are not hidden behind idle ones', async ($, on) => {
  const kept = new Map<string, unknown>([
    ['session:a1', peer('a1', '/r', 'idle one', { state: 'idle', activity: '' })],
    ['session:a2', peer('a2', '/r', 'idle two', { state: 'done', activity: '' })],
    ['session:a3', peer('a3', '/r', 'idle three', { state: 'idle', activity: '' })],
    ['session:a4', peer('a4', '/r', 'idle four', { state: 'done', activity: '' })],
    ['session:z9', peer('z9', '/r', 'deploy to prod', { state: 'waiting', activity: '' })],
  ])
  const clock = engine(on, { now: 'running' }, kept)
  await startIn($, '/r')
  await run(clock, 2_500)
  const ui = await $.ui.mount(PANE)
  const heading = (await ui.find({ type: 'Text', text: /^Sessions/ }))?.text ?? ''
  const waiting = await ui.find({ type: 'Text', text: /deploy to prod/ })
  await ui.unmount()
  expect(heading).toMatch(/1 working/)
  expect(waiting).toBeTruthy()
})

test('IMPROVE R6.3: a session started in / (or C:\\) does not list every session on the computer', async ($, on) => {
  const kept = new Map<string, unknown>([
    ['session:p1', peer('p1', '/home/me/other-project', 'unrelated work')],
    ['session:p2', peer('p2', 'C:\\Users\\me\\elsewhere', 'more unrelated work')],
  ])
  const clock = engine(on, { now: 'running' }, kept)
  await startIn($, '/')
  await run(clock, 2_500)
  const ui = await $.ui.mount(PANE)
  const listed = await ui.find({ type: 'Text', text: /unrelated work/ })
  await ui.unmount()
  expect(listed).toBeUndefined()
})

test('IMPROVE R6.3: a session in the home folder is not a peer of every project under it', async ($, on) => {
  const kept = new Map<string, unknown>([['session:p1', peer('p1', '/home/me', 'chatting in home')]])
  // This session is in a git repository under the home folder.
  const clock = engine(on, { now: 'running' }, kept, { repo: '/home/me/work/app' })
  await startIn($, '/home/me/work/app')
  await run(clock, 2_500)
  const ui = await $.ui.mount(PANE)
  const listed = await ui.find({ type: 'Text', text: /chatting in home/ })
  await ui.unmount()
  expect(listed).toBeUndefined()
})

test('BUG R6.3: a background-task notification does not rename the session for the others', async ($, on) => {
  const kept = new Map<string, unknown>()
  const clock = engine(on, { now: 'running' }, kept)
  await startIn($, '/r')
  await $.prompt.submit({ text: 'fix the login bug', wait: false, origin: { kind: 'composer' } })
  // A background agent finishes; the engine queues its notification as a prompt.
  await $.prompt.submit({ text: NOTICE, wait: false, isMeta: true, origin: { kind: 'task-notification' } } as never)
  await run(clock, 2_500)
  expect((kept.get('session:me') as { task?: string } | undefined)?.task).toBe('fix the login bug')
})

test('BUG R6.1/R4.1: a background-task notification is not a new prompt: the finished agent and Done line stay', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  const clock = engine(on, status)
  await startIn($, '/r')
  await $.prompt.submit({ text: 'look around', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'look around', turnId: 't1' })
  await $.agent.spawn(SPAWN)
  await $.turn.complete(MAIN_END)
  await clock.set(clock.now() + 1_000)
  status.now = 'completed'
  await $.turn.complete(AGENT_END)
  await $.prompt.submit({ text: NOTICE, wait: false, isMeta: true, origin: { kind: 'task-notification' } } as never)
  const ui = await $.ui.mount(PANE)
  const row = await ui.find({ type: 'Button', text: /Explore/ })
  const done = await ui.find({ type: 'Text', text: /^ Done / })
  await ui.unmount()
  expect(row).toBeTruthy()
  expect(done).toBeTruthy()
})

test('IMPROVE R6.3: a session whose background agents still run is not reported done at 100%', async ($, on) => {
  const kept = new Map<string, unknown>()
  const clock = engine(on, { now: 'running' }, kept)
  await startIn($, '/r')
  await $.prompt.submit({ text: 'review the repo', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'review the repo', turnId: 't1' })
  await $.agent.spawn(SPAWN)
  await $.turn.complete(MAIN_END)
  await run(clock, 2_500)
  expect((kept.get('session:me') as { state?: string } | undefined)?.state).toBe('working')
})

test('IMPROVE R6.3: an ended session is not published again by the ticker after session.end', async ($, on) => {
  const kept = new Map<string, unknown>()
  const clock = engine(on, { now: 'running' }, kept)
  await startIn($, '/r')
  await $.prompt.submit({ text: 'fix the login bug', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
  await $.turn.complete(MAIN_END)
  await run(clock, 2_500)
  expect(kept.has('session:me')).toBe(true)
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'me', resume: { id: 'me' } } as never)
  expect(kept.has('session:me')).toBe(false)
  await run(clock, 2_500)
  expect(kept.has('session:me')).toBe(false)
})

test('IMPROVE R6.3/R5.2: the week token count follows what other sessions add while this one is idle', async ($, on) => {
  const resetsAt = new Date(1_000 + 86_400_000).toISOString()
  const kept = new Map<string, unknown>([['week-tokens', { tokens: 10_000, resetsAt }]])
  const clock = engine(on, { now: 'running' }, kept)
  await startIn($, '/r')
  // Another session in the same project finishes a turn of 50k tokens.
  kept.set('week-tokens', { tokens: 60_000, resetsAt })
  await run(clock, 4_000)
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text ?? ''
  await ui.unmount()
  expect(row).toMatch(/60\.0k week/)
})

test('BUG R2.2/R7.4: a path under "Program Files (x86)" is cut to its last name', async ($, on) => {
  engine(on)
  await startIn($, '/r')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({
    tool: 'PowerShell',
    command: '& "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe" sign app.exe',
  })
  const ui = await $.ui.mount(WIDE)
  const row = (await ui.find({ type: 'Text', text: /^ {2}\S Run / }))?.text ?? ''
  await ui.unmount()
  expect(row).toContain('signtool.exe')
})

test('BUG R2.1: an agent row whose task holds ⚠️ (emoji presentation) fits 40 columns', async ($, on) => {
  engine(on)
  await startIn($, '/r')
  await $.agent.spawn({ ...SPAWN, description: '⚠️ tests ⚠️ lint ⚠️ types ⚠️ then report back' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Button', text: /Explore/ }))?.text ?? ''
  await ui.unmount()
  expect(cols(row)).toBeLessThanOrEqual(40)
})

test('BUG R3.4/R2.1: a Recent row with a CJK title keeps its time in 40 columns', async ($, on) => {
  engine(on)
  await startIn($, '/r')
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__clawd-at-work__plan', steps: [{ title: 'step', status: 'active' }] })
  await $.tool.call({ tool: 'Read', file_path: '/r/設定ファイルの説明書きと変更履歴.md' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ {2}\S Read 設定/ }))?.text ?? ''
  await ui.unmount()
  expect(cols(row)).toBeLessThanOrEqual(40)
  expect(row).toMatch(/\d\.\ds$/)
})
