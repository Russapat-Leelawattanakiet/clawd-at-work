// Probe tests written by the tester against REQUIREMENTS.md (R1.1-R7.4).
// A test named "BUG ..." or "IMPROVE ..." fails while the finding stands and
// passes once it is fixed; a test named "OK ..." checks a requirement that is met.
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
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

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

const AGENT_END = {
  answer: '',
  durationMs: 5,
  isAborted: false,
  turnId: 't',
  agentId: 'a1',
  reason: 'answer',
} as const

const MAIN_END = { answer: '', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' } as const

// The same engine stand-in as register.test.tsx, plus: a spawn that resumes
// answers the resumed id; a command containing `deny` is refused; a command
// containing `throw` makes the tool throw.
const counts = { thrown: 0 }
const engine = (on: On, status: { now: AgentStatus } = { now: 'running' }) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, {})
  let spawned = 0
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__clawd-at-work__plan' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) => {
    const command = String((e as { command?: unknown }).command ?? '')
    if (command.includes('throw')) {
      counts.thrown += 1
      throw new Error('tool blew up')
    }
    if (command.includes('deny')) return { deny: 'not allowed' }
    return command.includes('exit 1') ? { isError: true as const, result: 'failed', text: 'failed' } : { result: {} }
  })
  on('agent.spawn', (_, e) => {
    const resumed = (e as { resume?: { agentId: string } }).resume?.agentId
    return { agentId: resumed ?? `a${++spawned}`, model: 'test' }
  })
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

const start = ($: Parameters<Parameters<typeof test>[1]>[0]) =>
  $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

// Terminal columns a string takes: wide (CJK, fullwidth) characters take two.
const cols = (s: string) =>
  [...s].reduce((w, ch) => {
    const c = ch.codePointAt(0)!
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x1f300 && c <= 0x1faff)
    return w + (wide ? 2 : 1)
  }, 0)

const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

// ------------------------------------------------------------ R2.1 widths at 40 columns

test('BUG R1.4/R2.1: the Done line fits 40 columns, failed count included', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'change it', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\repo\\a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\repo\\b.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Bash', command: 'exit 1' })
  await $.turn.complete(MAIN_END)
  const ui = await $.ui.mount(PANE)
  const done = (await ui.find({ type: 'Text', text: /^ Done / }))?.text ?? ''
  await ui.unmount()
  expect(done).toMatch(/1 failed/)
  // Actual: ' Done     ✓ 0:30 · 2 files edited · 3 tools · 1 failed' (54 columns):
  // truncate-end cuts it after "· 2 files edited · 3" and the failed count never shows.
  expect(cols(done)).toBeLessThanOrEqual(40)
})

test('BUG R5.2/R2.1: a Session limit row with its reset time fits 40 columns', async ($, on) => {
  engine(on)
  await start($)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42.5, resetsAt: new Date(1_000 + 2 * 3_600_000 + 14 * 60_000).toISOString() }],
    changed: ['rateLimits'],
  })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ Session / }))?.text ?? ''
  await ui.unmount()
  expect(row).toMatch(/resets in 2h 14m$/)
  // Actual: 41 columns, so the last character of the reset time is cut.
  expect(cols(row)).toBeLessThanOrEqual(40)
})

test('BUG R4.1/R2.1: an agent bar line with its time and tool count fits 40 columns', async ($, on) => {
  const clock = engine(on)
  await start($)
  await $.agent.spawn(SPAWN)
  for (let i = 0; i < 12; i++) await $.tool.call({ tool: 'Bash', command: `ls ${i}`, agentId: 'a1' })
  await clock.set(1_000 + 65_000)
  const ui = await $.ui.mount(PANE)
  const bar = (await ui.find({ type: 'Text', text: /^ {4}━*(▛█▜|▜█▛|███)/ }))?.text ?? ''
  await ui.unmount()
  expect(bar).toMatch(/1:05 · 12 tools$/)
  // Actual: 43 columns; the tool count is cut to "12 t…".
  expect(cols(bar)).toBeLessThanOrEqual(40)
})

test('BUG R2.1: an agent row with a long plugin agent type does not overflow (Buttons cannot truncate)', async ($, on) => {
  engine(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'agent-sdk-dev:agent-sdk-verifier-typescript' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Button', text: /agent-sdk/ }))?.text ?? ''
  await ui.unmount()
  // Actual: '▸ ◐ agent-sdk-dev:agent-sdk-verifier-typescript  …' (51 columns) wraps.
  expect(cols(row)).toBeLessThanOrEqual(40)
})

test('BUG R2.1/R7.2: an agent row with a CJK task description fits 40 columns', async ($, on) => {
  engine(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, description: '設定ファイルとテストコードを調べて原因を探す作業です' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Button', text: /Explore/ }))?.text ?? ''
  await ui.unmount()
  // Actual: the cut counts characters, not columns: 25 wide characters = 50 columns + 13.
  expect(cols(row)).toBeLessThanOrEqual(40)
})

test('IMPROVE R2.1: the Tokens row with a cost fits 40 columns', async ($, on) => {
  engine(on)
  await start($)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 1.23 }, changed: ['cost'] })
  const usage = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 500 }
  await $.turn.complete({ ...MAIN_END, usage: { ...usage, model: 'test' } })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text ?? ''
  await ui.unmount()
  // Actual: ' Tokens   10.0k session · 10.0k week · $1.23' (44 columns): the cost is cut.
  expect(cols(row)).toBeLessThanOrEqual(40)
})

// ------------------------------------------------------------ R2.5 cutting

test('BUG R2.5: a plan title cut at an emoji never leaves half a surrogate pair', async ($, on) => {
  engine(on)
  await start($)
  // 34 letters then an emoji: at 40 columns the title is cut at 36 code units,
  // keeping 35, which splits the emoji.
  await $.tool.call({
    tool: 'mcp__clawd-at-work__plan',
    steps: [{ title: `${'a'.repeat(34)}🚀 launch the thing`, status: 'pending' }],
  })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /aaaa/ }))?.text ?? ''
  await ui.unmount()
  expect(row.endsWith('…')).toBe(true)
  // Actual: '  ○ aaaa…aaaa�…' - the kit shows the lone high surrogate as U+FFFD.
  expect(hasLoneSurrogate(row) || row.includes('�')).toBe(false)
})

test('BUG R2.5: a long command target cut at an emoji never leaves half a surrogate pair', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  // TARGET_MAX is 40: the cut keeps 39 code units, the 39th the emoji's first half.
  await $.tool.call({ tool: 'Bash', command: `echo ${'b'.repeat(33)}🎉🎉 done` })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 } })
  const row = (await ui.find({ type: 'Text', text: /Run echo/ }))?.text ?? ''
  await ui.unmount()
  expect(row).toMatch(/…/)
  // Actual: '  ✓ Run echo bbbb…bbbb�…'.
  expect(hasLoneSurrogate(row) || row.includes('�')).toBe(false)
})

// ------------------------------------------------------------ R2.2 shell commands

test('BUG R2.2: a redirect to /dev/null keeps its redirect, not just "null"', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test 2>/dev/null' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 } })
  const row = (await ui.find({ type: 'Text', text: /Run npm test/ }))?.text ?? ''
  await ui.unmount()
  // Actual: 'Run npm test null'.
  expect(row).not.toMatch(/Run npm test null/)
  expect(row).toMatch(/Run npm test 2>/)
})

test('BUG R2.2: a flag with a long path value keeps the flag', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'node app.js --config=/etc/myapp/conf.json' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 } })
  const row = (await ui.find({ type: 'Text', text: /Run node app/ }))?.text ?? ''
  await ui.unmount()
  // Actual: 'Run node app.js conf.json' (the flag is gone).
  expect(row).toMatch(/--config=/)
})

test('IMPROVE R2.2: quoted prose with slashes is not cut as a path', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "Fix and/or tidy docs/api"' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 } })
  const row = (await ui.find({ type: 'Text', text: /Run git commit/ }))?.text ?? ''
  await ui.unmount()
  // Actual: 'Run git commit -m "api"'.
  expect(row).toMatch(/Fix and\/or/)
})

test('OK R2.2: leading folder changes are dropped in cmd and PowerShell forms', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'cd /d C:\\work\\repo && npm run build' })
  await $.tool.call({ tool: 'PowerShell', command: "Set-Location -Path 'C:\\a b\\repo'; npm run lint" })
  await $.tool.call({ tool: 'Bash', command: 'pushd /tmp/x && make check' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 } })
  expect(await ui.find({ type: 'Text', text: /Run npm run build/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Run npm run lint/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Run make check/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Set-Location|pushd|cd \/d/ })).toBeUndefined()
  await ui.unmount()
})

// ------------------------------------------------------------ R2.6 / R7.4 line endings

test('IMPROVE R2.6/R7.4: a CRLF multi-line PowerShell command shows its first line with no stray \\r', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm test\r\nnpm run build' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /Running npm test/ }))?.text ?? ''
  await ui.unmount()
  // Actual: 'Running npm test\r  step 0 · 1 tool' - a carriage return mid-line.
  expect(row).not.toMatch(/\r/)
})

test('OK R2.6: a multi-line Bash command shows only its first line', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test\nnpm run build' })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /npm run build/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Running npm test/ })).toBeTruthy()
  await ui.unmount()
})

// ------------------------------------------------------------ R1.2 / R2.3 targets

test('BUG R1.2: a Grep with a path says what it searches for, not the folder', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Grep', pattern: 'TODO', path: 'C:\\repo\\hooks' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /Searching for/ }))?.text ?? ''
  await ui.unmount()
  // Actual: 'Searching for hooks'.
  expect(row).toMatch(/Searching for TODO/)
})

test('BUG R1.2: a Glob with a folder path ending in a slash still names its pattern', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Glob', pattern: '**/*.tsx', path: '/home/me/repo/' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /Finding files/ }))?.text ?? ''
  await ui.unmount()
  // Actual: 'Finding files  step 0 · 1 tool' - the path's base name is '' and the pattern is never tried.
  expect(row).toMatch(/\*\*\/\*\.tsx/)
})

test('IMPROVE R2.3/R1.2: a NotebookEdit names its notebook', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'NotebookEdit', notebook_path: 'C:\\repo\\analysis.ipynb', new_source: 'x = 1' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /Editing notebook/ }))?.text ?? ''
  await ui.unmount()
  expect(row).toMatch(/Editing notebook analysis\.ipynb/)
})

test('IMPROVE R1.2: while a tool call streams, the activity line is in plain words, not the tool name', async ($, on) => {
  engine(on)
  on('turn.step', async function* (_: unknown, e: { turnId: string; index: number }) {
    yield { kind: 'tool' as const, index: 0, id: 'tu9', name: 'mcp__github__create_pull_request' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use', usage: null } as never
  } as never)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'test', messageCount: 1 } as never)
  let ui: Awaited<ReturnType<typeof $.ui.mount>> | undefined
  let row = ''
  for await (const _ of stream) {
    ui = await $.ui.mount(PANE)
    row = (await ui.find({ type: 'Text', text: /getting ready|Running|github/ }))?.text ?? ''
    await ui.unmount()
  }
  // Actual: 'getting ready: github create_pull_request…'.
  expect(row).not.toMatch(/create_pull_request/)
})

// ------------------------------------------------------------ R4.1 agents

test('BUG R4.1: workflow agents sharing one tool_use_id each keep their own row and calls', async ($, on) => {
  engine(on)
  await start($)
  const wf = (i: number) => ({ ...SPAWN, tool_use_id: 'wf-call', workflow: { runId: 'wf_1', agentIndex: i } })
  await $.agent.spawn(wf(1) as never)
  await $.agent.spawn(wf(2) as never)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'a1' })
  const ui = await $.ui.mount(PANE)
  const rows = await ui.findAll({ type: 'Button', text: /Explore/ })
  const bars = (await ui.findAll({ type: 'Text', text: /tools?$/ })).map(t => t.text)
  await ui.unmount()
  expect(rows).toHaveLength(2)
  // Actual: both rows were patched to agentId a2, so a1's two calls count nowhere.
  expect(bars.some(t => /2 tools$/.test(t))).toBe(true)
})

test('BUG R4.1: a resumed agent keeps one row, not two', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  engine(on, status)
  await start($)
  await $.agent.spawn(SPAWN)
  status.now = 'completed'
  await $.turn.complete(AGENT_END)
  // Claude sends the finished agent a follow-up: the engine raises agent.spawn with resume.
  status.now = 'running'
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2', resume: { agentId: 'a1' } } as never)
  const ui = await $.ui.mount(PANE)
  const rows = await ui.findAll({ type: 'Button', text: /Explore/ })
  await ui.unmount()
  // Actual: 2 rows for agent a1 ("2 agents").
  expect(rows).toHaveLength(1)
})

test('BUG R7.2: an agent spawned with no description does not crash the pane', async ($, on) => {
  engine(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, description: undefined } as never)
  const ui = await $.ui.mount(PANE)
  // Actual: render throws reading r.detail.length, so nothing draws.
  expect(await ui.find({ type: 'Text', text: /^Agents/ })).toBeTruthy()
  await ui.unmount()
})

test('OK R4.1: a refused spawn shows as failed, and running agents are never hidden', async ($, on) => {
  engine(on)
  on('agent.spawn', { subagentType: 'Plan' } as never, () => ({ deny: 'no' }))
  await start($)
  await $.agent.spawn({ ...SPAWN, subagentType: 'Plan' } as never).catch(() => undefined)
  for (const id of ['t2', 't3', 't4', 't5', 't6']) await $.agent.spawn({ ...SPAWN, tool_use_id: id })
  const SHORT = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 16 } } }
  const ui = await $.ui.mount(SHORT)
  const running = await ui.findAll({ type: 'Text', text: /^ ◐ Explore/ })
  const buttons = await ui.findAll({ type: 'Button', text: /◐ Explore/ })
  expect(running.length + buttons.length).toBe(5)
  await ui.unmount()
})

test('OK R4.2: an agent dropdown shows readable targets (cd dropped, paths cut)', async ($, on) => {
  engine(on)
  await start($)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Bash', command: 'cd C:\\Users\\me\\repo && npm test', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: '/home/me/repo/src/deep/file.ts', agentId: 'a1' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'agent-tu1' })
  expect(await ui.find({ type: 'Text', text: /Bash\s+npm test/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Read\s+file\.ts/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Users|home/ })).toBeUndefined()
  await ui.unmount()
})

// ------------------------------------------------------------ R4.3 skills

test('BUG R4.3: every loaded skill is listed or counted, even in a short pane', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({
    tool: 'mcp__clawd-at-work__plan',
    steps: ['A', 'B', 'C', 'D'].map((title, i) => ({ title, status: i === 0 ? 'active' : 'pending' })),
  })
  for (const skill of ['alpha', 'beta', 'gamma']) await $.tool.call({ tool: 'Skill', skill })
  const SHORT = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 24 } } }
  const ui = await $.ui.mount(SHORT)
  const shown = await ui.findAll({ type: 'Text', text: /^ \S (alpha|beta|gamma) / })
  const counted = await ui.find({ type: 'Text', text: /more/ })
  await ui.unmount()
  // Actual: only "gamma" is listed, alpha and beta vanish with no count.
  expect(shown.length === 3 || counted !== undefined).toBe(true)
})

// ------------------------------------------------------------ R1.3 / R1.4 endings

test('OK R1.3/R1.4: an interrupted turn reads Stopped and Clawd does not cheer', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.md' })
  await $.turn.complete({ ...MAIN_END, durationMs: 4_000, isAborted: true, reason: 'aborted' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Stopped / }))?.text).toMatch(/^ Stopped  ■ 0:04/)
  expect(await ui.find({ type: 'Text', text: /^done!$/ })).toBeUndefined()
  await ui.unmount()
})

test('OK R1.3/R1.4: a refusal reads Failed and Clawd does not cheer', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ ...MAIN_END, reason: 'refusal', refusal: { category: null, explanation: null } } as never)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ Failed / })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /^done!$/ })).toBeUndefined()
  await ui.unmount()
})

test('OK R1.3/R3.4: a denied call is a snag and is marked ✗ in Recent', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__clawd-at-work__plan', steps: [{ title: 'Do it', status: 'active' }] })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf deny' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
  expect(await ui.find({ type: 'Text', text: /^hit a snag$/ })).toBeTruthy()
  expect((await ui.find({ type: 'Text', text: /Run rm/ }))?.text).toMatch(/^  ✗ Run rm/)
  await ui.unmount()
})

test('OK R7.1: a tool that throws runs once and its error reaches the caller', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  counts.thrown = 0
  let threw = false
  const r = await $.tool.call({ tool: 'Bash', command: 'throw' }).catch(() => {
    threw = true
  })
  if (!threw) threw = (r as { isError?: boolean } | undefined)?.isError === true
  expect(counts.thrown).toBe(1)
  expect(threw).toBe(true)
})

// ------------------------------------------------------------ R7.2 odd input

test('OK R7.2: odd plan and tool inputs never crash the pane', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const odd = [
    { tool: 'mcp__clawd-at-work__plan', steps: 'not a list' },
    { tool: 'mcp__clawd-at-work__plan', steps: [null, 3, { title: 7 }, { title: '' }, { title: 'ok', status: 'weird' }] },
    { tool: 'TodoWrite', todos: null },
    { tool: 'SomeUnknownTool', command: 42, file_path: null, prompt: '' },
    { tool: 'Read', file_path: '' },
    { tool: 'Bash', command: '' },
    { tool: 'Bash', command: 'x'.repeat(10_000) },
    { tool: 'Skill' },
  ]
  for (const input of odd) await $.tool.call(input as never)
  await $.tool.call({
    tool: 'mcp__clawd-at-work__plan',
    steps: Array.from({ length: 30 }, (_, i) => ({ title: `Step ${i + 1}`, status: 'pending' })),
  })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Plan / }))?.text).toMatch(/0\/20 steps done/)
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__clawd-at-work__plan', steps: [] })
  const ui2 = await $.ui.mount(PANE)
  expect(await ui2.find({ type: 'Text', text: /^Agents/ })).toBeTruthy()
  await ui2.unmount()
})

test('IMPROVE R7.2: a Skill call with no skill name is not listed as "undefined"', async ($, on) => {
  engine(on)
  await start($)
  await $.tool.call({ tool: 'Skill' } as never)
  const ui = await $.ui.mount(PANE)
  const found = await ui.find({ type: 'Text', text: /undefined/ })
  await ui.unmount()
  expect(found).toBeUndefined()
})

// ------------------------------------------------------------ R5.1 / R6.1

test('OK R5.1: Windows spellings of one file merge; an agent read is not listed', async ($, on) => {
  engine(on)
  await start($)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\Repo\\Src\\App.ts' })
  await $.tool.call({ tool: 'Write', file_path: 'c:/repo/src/app.ts', content: 'x' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\other.ts', agentId: 'a1' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Files / }))?.text).toMatch(/^ Files    ✎ App\.ts\s*$/)
  await ui.unmount()
})

test('OK R6.1: a new prompt clears Recent, Files, Done, plan and finished skills; running agents stay', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  engine(on, status)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'mcp__clawd-at-work__plan', steps: [{ title: 'Do it', status: 'active' }] })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.md' })
  await $.tool.call({ tool: 'Skill', skill: 'one' })
  await $.agent.spawn(SPAWN)
  await $.turn.complete(MAIN_END)
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ (Plan|Steps|Recent|Files|Done) / })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: / one / })).toBeUndefined()
  expect(await ui.findAll({ type: 'Button', text: /Explore/ })).toHaveLength(1)
  await ui.unmount()
})

// ------------------------------------------------------------ R3.3 estimates

test('OK R3.3: the Claude bar and an active step hold below 100% while work runs', async ($, on) => {
  const clock = engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.set(1_000 + 2 * 60_000)
  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/ 95%/)
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__clawd-at-work__plan', steps: [{ title: 'Only', status: 'active' }] })
  await clock.set(1_000 + 4 * 60_000)
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/ 95%/)
  await ui.unmount()
})

test('OK R7.2: a turn whose usage lacks the cache counts does not show NaN tokens', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.complete({ ...MAIN_END, usage: { input_tokens: 100, output_tokens: 50, model: 'test' } } as never)
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text ?? ''
  await ui.unmount()
  expect(row).not.toMatch(/NaN/)
})

// ------------------------------------------------------------ R3.2 auto steps

test('IMPROVE R3.2/R1: without a plan, a failed call is not shown as a done ✓ step', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test; exit 1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.md' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /Run npm test/ }))?.text ?? ''
  await ui.unmount()
  // Actual: '  ✓ Run npm test; exit 1' - the failure shows nowhere in Steps.
  expect(row).not.toMatch(/✓/)
})

test('IMPROVE R3.2/R2.4: a merged step keeps its ×N count when its title is cut', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  const file = 'C:\\repo\\a-rather-long-configuration-file.json'
  await $.tool.call({ tool: 'Read', file_path: file })
  await $.tool.call({ tool: 'Read', file_path: file })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\b.md' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /Read a-rather/ }))?.text ?? ''
  await ui.unmount()
  // Actual: '  ✓ Read a-rather-long-configuration-f…' - the ×2 is cut away.
  expect(row).toMatch(/×2/)
})

test('IMPROVE R5.2: a token count just under a million reads 1.0M, not 1000.0k', async ($, on) => {
  engine(on)
  await start($)
  const usage = { input_tokens: 999_960, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await $.turn.complete({ ...MAIN_END, usage: { ...usage, model: 'test' } })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text ?? ''
  await ui.unmount()
  expect(row).not.toMatch(/1000\.0k/)
})

test('OK R5.2: limit bars turn yellow from 70% and red from 90%', async ($, on) => {
  engine(on)
  await start($)
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 69.4 },
      { kind: 'seven_day', percentUsed: 70 },
      { kind: 'spend_limit', percentUsed: 90 },
    ],
    changed: ['rateLimits'],
  } as never)
  const ui = await $.ui.mount(PANE)
  const bars = (await ui.findAll({ type: 'Text', text: /^━+$/ })).map(t => t.props.color)
  await ui.unmount()
  expect(bars).toEqual(['success', 'warning', 'error'])
})

// ------------------------------------------------------------ R7.2 control characters

// A tab or carriage return draws; ESC, BEL or backspace make the Pane refuse the
// whole tree ("a text child holds a control character"), so the pane goes blank.
for (const [verdict, name, ch] of [
  ['OK', 'a tab', '\t'],
  ['OK', 'a lone carriage return', '\r'],
  ['BUG', 'an escape (ANSI colour)', '\x1b'],
  ['BUG', 'a bell', '\x07'],
  ['BUG', 'a backspace', '\b'],
] as const) {
  test(`${verdict} R7.2: a command whose first line holds ${name} does not blank the pane`, async ($, on) => {
    engine(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: `printf 'a${ch}b' > out.txt` })
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: /^Agents/ })).toBeTruthy()
    await ui.unmount()
  })
}
