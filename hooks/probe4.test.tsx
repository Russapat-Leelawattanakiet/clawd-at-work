// Round 4 probe tests, written by the tester against REQUIREMENTS.md (R1.1-R7.4).
// A test named "BUG ..." fails while the finding stands and passes once it is
// fixed; "NICE ..." shows a nice-to-have; "OK ..." checks a round-3 change holds.
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

// The engine stand-in of probe3.test.tsx, with the session id and the tool
// answer under the test's control.
type Opts = { repo?: string; id?: () => string; tool?: (e: Record<string, unknown>) => unknown }
const engine = (on: On, kept = new Map<string, unknown>(), opts: Opts = {}) => {
  const status: { now: AgentStatus } = { now: 'running' }
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
  on('session.id', () => ({ value: opts.id?.() ?? 'me' }) as never)
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
const runRow = async ($: T, command: string) => {
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command })
  const ui = await $.ui.mount(WIDE)
  const row = (await ui.find({ type: 'Text', text: /^ {2}\S Run / }))?.text ?? ''
  await ui.unmount()
  return row
}

// ------------------------------------------------------------ R2.2 regression of NOT_PATH

test('BUG R2.2: a node -p one-liner is not cut into "package.json\').version"', async ($, on) => {
  engine(on)
  await startIn($, '/r')
  const row = await runRow($, `node -p "require('./node_modules/typescript/package.json').version"`)
  // Actual: '  ◐ Run node -p package.json').version' (round 3 took "(" out of NOT_PATH).
  expect(row).toContain('require(')
})

test('BUG R2.2: a python -c one-liner is not cut into "sales.csv\').read())"', async ($, on) => {
  engine(on)
  await startIn($, '/r')
  const row = await runRow($, `python -c "print(open('data/raw/2024/sales.csv').read())"`)
  // Actual: '  ◐ Run python -c sales.csv').read())'.
  expect(row).toContain('open(')
})

test('OK R2.2: a Next.js route-group path is still cut to its file name', async ($, on) => {
  engine(on)
  await startIn($, '/r')
  const row = await runRow($, 'npx prettier --write app/(marketing)/about/page.tsx')
  expect(row).toMatch(/Run npx prettier --write page\.tsx/)
})

// ------------------------------------------------------------ R6.3 round-3 changes

test('OK R6.3: after /clear the session reports again under its new id, and the old id is gone', async ($, on) => {
  const kept = new Map<string, unknown>()
  let id = 'old'
  const clock = engine(on, kept, { id: () => id })
  await startIn($, '/r')
  await $.prompt.submit({ text: 'fix the login bug', wait: false, origin: { kind: 'composer' } })
  await run(clock, 2_500)
  expect(kept.has('session:old')).toBe(true)
  id = 'new'
  await $.session.end({ reason: 'clear', sessionId: 'old', resume: { id: 'old' } } as never)
  expect(kept.has('session:old')).toBe(false)
  await run(clock, 2_500)
  expect(kept.has('session:old')).toBe(false)
  expect(kept.get('session:new')).toMatchObject({ id: 'new', cwd: '/r', task: '' })
})

test('OK R6.3: a session waiting on AskUserQuestion is reported waiting', async ($, on) => {
  const kept = new Map<string, unknown>()
  let answer: (v: unknown) => void = () => {}
  const gate = new Promise(resolve => (answer = resolve))
  const clock = engine(on, kept, { tool: e => (e.tool === 'AskUserQuestion' ? gate : undefined) })
  await startIn($, '/r')
  await $.prompt.submit({ text: 'pick a db', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'pick a db', turnId: 't1' })
  const pending = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await run(clock, 2_500)
  expect((kept.get('session:me') as { state?: string } | undefined)?.state).toBe('waiting')
  answer({ result: {} })
  await pending
})

test('OK R6.3/R6.1: a peer session message neither clears the Done line nor renames the session', async ($, on) => {
  const kept = new Map<string, unknown>()
  const clock = engine(on, kept)
  await startIn($, '/r')
  await $.prompt.submit({ text: 'fix the login bug', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
  await $.turn.complete(MAIN_END)
  await $.prompt.submit({ text: 'hello from another session', wait: false, origin: { kind: 'peer' } } as never)
  await run(clock, 2_500)
  const ui = await $.ui.mount(PANE)
  const done = await ui.find({ type: 'Text', text: /^ Done / })
  await ui.unmount()
  expect(done).toBeTruthy()
  expect((kept.get('session:me') as { task?: string } | undefined)?.task).toBe('fix the login bug')
})

// ------------------------------------------------------------ nice-to-haves

test('NICE R6.3: the Sessions heading does not count done and failed sessions as idle', async ($, on) => {
  const kept = new Map<string, unknown>([
    ['session:p1', peer('p1', '/r', 'fix the login bug')],
    ['session:p2', peer('p2', '/r', 'write docs', { state: 'done', activity: '' })],
    ['session:p3', peer('p3', '/r', 'deploy', { state: 'failed', activity: '' })],
  ])
  const clock = engine(on, kept)
  await startIn($, '/r')
  await run(clock, 2_500)
  const ui = await $.ui.mount(PANE)
  const heading = (await ui.find({ type: 'Text', text: /^Sessions/ }))?.text ?? ''
  await ui.unmount()
  // Actual: 'Sessions   1 working · 2 idle'.
  expect(heading).not.toMatch(/2 idle/)
})

// Terminal columns with every combining mark (\p{M}) drawn in none, as
// terminals draw Thai, Hindi and Arabic vowel signs and tone marks.
const termCols = (s: string) =>
  [...s].reduce((w, ch) => (/\p{M}|‍/u.test(ch) ? w : w + ((ch.codePointAt(0)! >= 0x2e80 ? 2 : 1))), 0)

test('NICE R6.3/R2.1: a Thai task keeps its percent at the end of the 40-column row', async ($, on) => {
  const kept = new Map<string, unknown>([
    ['session:p1', peer('p1', '/r', 'แก้ไขบั๊กการเข้าสู่ระบบและเพิ่มการทดสอบหน่วยให้ครบ')],
  ])
  const clock = engine(on, kept)
  await startIn($, '/r')
  await run(clock, 2_500)
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /แก้ไข/ }))?.text ?? ''
  await ui.unmount()
  expect(row).toMatch(/40%$/)
  // Actual: fewer columns; Thai marks are counted as a column each, so the
  // task is cut early and the percent sits left of the others.
  expect(termCols(row)).toBe(40)
})

test('NICE R6.1/R6.3: a prompt a plugin submits as the person\'s own words is a new task', async ($, on) => {
  const kept = new Map<string, unknown>()
  const clock = engine(on, kept)
  await startIn($, '/r')
  await $.prompt.submit({ text: 'fix the login bug', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({
    text: 'now write the docs',
    wait: false,
    origin: { kind: 'plugin', name: 'voice', asUser: true },
  } as never)
  await run(clock, 2_500)
  expect((kept.get('session:me') as { task?: string } | undefined)?.task).toBe('now write the docs')
})
