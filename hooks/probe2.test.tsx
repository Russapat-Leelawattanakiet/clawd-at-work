// Round 2 probe tests, written by the tester against REQUIREMENTS.md (R1.1-R7.4).
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
const usageOf = (n: number) => ({
  input_tokens: n,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'test',
})

// The engine stand-in of probe.test.tsx: spawns answer a1, a2, ... (a resume
// answers the resumed id); `status.now` is what agent.list reports for the
// newest agent; `stored` seeds the store (null: the test answers the store itself).
const engine = (on: On, status: { now: AgentStatus } = { now: 'running' }, stored: Record<string, unknown> | null = {}) => {
  const clock = mock.clock(on, { now: 1_000 })
  if (stored) mock.store(on, stored)
  let spawned = 0
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__clawd-at-work__plan' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) =>
    String((e as { command?: unknown }).command ?? '').includes('exit 1')
      ? { isError: true as const, result: 'failed', text: 'failed' }
      : { result: {} },
  )
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

// Terminal columns a string takes, by East Asian Width: CJK, fullwidth and
// emoji take two, including the emoji below U+1F300 that terminals draw wide
// (✅ ❌ ✨ ⭐ ⚡ ...); combining marks and variation selectors take none.
const WIDE_BMP = new Set([0x231a, 0x231b, 0x23f0, 0x23f3, 0x2614, 0x2615, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be,
  0x26c4, 0x26c5, 0x26d4, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26fa, 0x26fd, 0x2705, 0x270a, 0x270b, 0x2728, 0x274c,
  0x274e, 0x2753, 0x2754, 0x2755, 0x2757, 0x2795, 0x2796, 0x2797, 0x27b0, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b55])
const cols = (s: string) =>
  [...s].reduce((w, ch) => {
    const c = ch.codePointAt(0)!
    if ((c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return w
    const wide =
      WIDE_BMP.has(c) ||
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0x1f300 && c <= 0x1faff)
    return w + (wide ? 2 : 1)
  }, 0)

// ------------------------------------------------------------ R6.3 sessions

test('BUG R6.3: learning in one session does not erase typical times another session learned meanwhile', async ($, on) => {
  engine(on, { now: 'running' }, null)
  // The shared store, as a file every session of the user reads and writes.
  const shared: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: shared[e.key] }))
  on('store.set', (_, e) => {
    shared[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  await start($)
  // Another Claude Code session, running at the same time, learns how long a
  // Plan agent takes and saves it to the shared store.
  shared['agent-typical'] = { Plan: { avgMs: 5_000, n: 3 } }
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete(MAIN_END)
  const saved = shared['agent-typical'] as Record<string, unknown>
  expect(saved.__main__).toBeTruthy()
  // Actual: undefined. learn() writes this session's whole copy, read once at
  // session.start, over the store: the other session's learning is lost.
  expect(saved.Plan).toBeTruthy()
})

test('IMPROVE R6.3/R5.2: after /clear the new session starts its own token count and Done line', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })
  await $.turn.complete({ ...MAIN_END, usage: usageOf(10_000) })
  // /clear: the conversation ends and the process goes on under a new session
  // id; no session.start fires for it.
  await $.session.end({ reason: 'clear', sessionId: 's1', resume: { id: 's1' } } as never)
  const ui = await $.ui.mount(PANE)
  const tokensRow = (await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text ?? ''
  const done = await ui.find({ type: 'Text', text: /^ Done / })
  await ui.unmount()
  // Actual: ' Tokens   10.0k session · 10.0k week' and the old ' Done ✓ 0:30 · 1 file edited ...'.
  expect(tokensRow).toMatch(/^ Tokens {3}0 session/)
  expect(done).toBeUndefined()
})

// ------------------------------------------------------------ R2.2 shell commands

for (const [name, command, kept] of [
  ['a sed substitution', "sed -i 's/oldName/newName/g' src/app.ts", 's/oldName/newName/g'],
  ['a grep alternation', 'grep -rn "TODO\\|FIXME\\|XXX" src', 'TODO\\|FIXME'],
  ['a regex with escapes', 'rg "function\\s+\\w+" hooks', 'function'],
  ['printf escapes', "printf 'a\\tb\\tc\\n' > out.txt", 'a\\tb'],
  ['a bash &> redirect', 'npm test &>/dev/null', '&>/dev/null'],
] as const) {
  test(`BUG R2.2: ${name} is not cut as if it were a path`, async ($, on) => {
    engine(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command })
    const ui = await $.ui.mount(WIDE)
    const row = (await ui.find({ type: 'Text', text: /^ {2}\S Run / }))?.text ?? ''
    await ui.unmount()
    // Actual: 'Run sed -i g app.ts', 'Run grep -rn |XXX src', 'Run rg w+ hooks',
    // 'Run printf n > out.txt', 'Run npm test null'.
    expect(row).toContain(kept)
  })
}

test('OK R2.2: long paths are still cut, short ones and URLs kept', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'cd C:\\Users\\me\\repo && node C:\\Users\\me\\tools\\gen.js x.io/a 2>/dev/null' })
  await $.tool.call({ tool: 'Bash', command: 'curl https://x.io/a/b/c -o /tmp/dl/out/f.bin' })
  const ui = await $.ui.mount(WIDE)
  const rows = (await ui.findAll({ type: 'Text', text: /^ {2}\S Run / })).map(t => t.text)
  await ui.unmount()
  expect(rows[0]).toBe('  ✓ Run node gen.js x.io/a 2>/dev/null')
  expect(rows[1]).toBe('  ✓ Run curl https://x.io/a/b/c -o f.bin')
})

// ------------------------------------------------------------ R1.4 Done line

test('IMPROVE R1.4: at 40 columns the Done line keeps the tool count when files were edited', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'change it', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/b.ts', old_string: 'x', new_string: 'y' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/c.ts' })
  await $.turn.complete(MAIN_END)
  const ui = await $.ui.mount(PANE)
  const done = (await ui.find({ type: 'Text', text: /^ Done / }))?.text ?? ''
  await ui.unmount()
  // Actual: ' Done     ✓ 0:30 · 2 files edited' - the long files form is taken first
  // and the tool count dropped, though ' Done     ✓ 0:30 · 2 edited · 3 tools' fits (37).
  expect(done).toMatch(/3 tools/)
  expect(cols(done)).toBeLessThanOrEqual(40)
})

// ------------------------------------------------------------ R2.1 widths

test('BUG R4.3/R2.1: a long plugin skill name is cut so its time still shows in 40 columns', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Skill', skill: 'cowork-plugin-management:cowork-plugin-customizer' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ \S cowork-plugin/ }))?.text ?? ''
  await ui.unmount()
  // Actual: ' ◐ cowork-plugin-management:cowork-plugin-customizer  0:00' (58 columns):
  // the pane cuts the end, so the skill's time never shows.
  expect(cols(row)).toBeLessThanOrEqual(40)
  expect(row).toMatch(/\d:\d\d$/)
})

test('BUG R2.1/R5.1: the Files row with CJK file names fits and keeps its +N count', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (const name of ['設定設定設定', '画面画面画面', '試験試験試験']) {
    await $.tool.call({ tool: 'Edit', file_path: `/repo/${name}.ts`, old_string: 'x', new_string: 'y' })
  }
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ Files / }))?.text ?? ''
  await ui.unmount()
  // Actual: ' Files    ✎ 設定設定設定.ts  ✎ 画面画面画面.ts  +1' (52 columns): names are
  // measured in characters, not columns, so the count is cut off.
  expect(cols(row)).toBeLessThanOrEqual(40)
  expect(row).toMatch(/\+\d+$/)
})

test('BUG R2.1: an agent row whose task holds ✅ emoji fits 40 columns (Buttons cannot truncate)', async ($, on) => {
  engine(on)
  await start($)
  await $.agent.spawn({ ...SPAWN, description: '✅ tests ✅ lint ✅ types then report back' })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Button', text: /Explore/ }))?.text ?? ''
  await ui.unmount()
  // Actual: 41 columns. charWidth counts ✅ (U+2705, East Asian Wide) as one column.
  expect(cols(row)).toBeLessThanOrEqual(40)
})

test('IMPROVE R2.1: the Tokens row with a cost fits 40 columns once the week passes 100M tokens', async ($, on) => {
  engine(on, { now: 'running' }, { 'week-tokens': { tokens: 111_100_000, resetsAt: new Date(1_000 + 86_400_000).toISOString() } })
  await start($)
  await $.session.measure({ context: { window: 200_000 }, rateLimits: [], cost: { usd: 45.67 }, changed: ['cost'] })
  await $.turn.complete({ ...MAIN_END, usage: usageOf(12_300_000) })
  const ui = await $.ui.mount(PANE)
  const row = (await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text ?? ''
  await ui.unmount()
  // Actual: ' Tokens   12.3M sess · 123.4M wk · $45.67' (41 columns): the cost's last digit is cut.
  expect(cols(row)).toBeLessThanOrEqual(40)
})

// ------------------------------------------------------------ R2.4 plan titles

test('IMPROVE R2.4: in a wide pane a plan title gets the full width before it is cut', async ($, on) => {
  engine(on)
  await start($)
  const title = 'Update the README install section with the new marketplace command'
  await $.tool.call({ tool: 'mcp__clawd-at-work__plan', steps: [{ title, status: 'pending' }] })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 100 } })
  const row = (await ui.find({ type: 'Text', text: /Update the README/ }))?.text ?? ''
  await ui.unmount()
  // Actual: cut at STEP_MAX (60) when stored: '  ○ Update the README ... new marketp…' with 30 columns to spare.
  expect(row).toContain(title)
})

// ------------------------------------------------------------ R4 agents and skills

test('IMPROVE R4.3: a skill the person runs as /name is listed', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: '/code-review', turnId: 't1' })
  // The engine expands the skill's prompt for the model (`/name`, the Skill tool, a preload).
  await $.skill.prompt({ skill: 'code-review', text: 'Review the diff.' } as never)
  const ui = await $.ui.mount(PANE)
  const row = await ui.find({ type: 'Text', text: /code-review/ })
  await ui.unmount()
  // Actual: Skills reads 'none yet': only Skill tool calls are tracked.
  expect(row).toBeTruthy()
})

test('IMPROVE R4.2: an agent dropdown names an MCP tool readably and its target shows in 40 columns', async ($, on) => {
  engine(on)
  await start($)
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'mcp__claude_ai_Linear__list_issues', query: 'login bug', agentId: 'a1' })
  const ui = await $.ui.mount(PANE)
  await ui.press({ key: 'agent-tu1' })
  const row = (await ui.find({ type: 'Text', text: /list.issues/ }))?.text ?? ''
  await ui.unmount()
  // Actual: '      ✓ mcp__claude_ai_Linear__list_issues login bug  0.0s' (56 columns):
  // the raw name fills the line, so the target is cut off. The main loop uses toolName().
  expect(row).not.toMatch(/mcp__/)
  expect(row.slice(0, 40)).toContain('login bug')
})

test('IMPROVE R4.1: a resumed agent is timed from its resume, not across the idle gap', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  const clock = engine(on, status)
  await start($)
  await $.agent.spawn(SPAWN)
  await clock.set(1_000 + 20_000)
  status.now = 'completed'
  await $.turn.complete(AGENT_END)
  // Ten minutes later Claude sends the finished agent a follow-up.
  await clock.set(1_000 + 10 * 60_000)
  status.now = 'running'
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2', resume: { agentId: 'a1' } } as never)
  const ui = await $.ui.mount(PANE)
  const bar = (await ui.find({ type: 'Text', text: /^ {4}━*(▛█▜|▜█▛|███)/ }))?.text ?? ''
  await ui.unmount()
  // Actual: '    ━━━…▛█▜  95%  10:00 · 0 tools' - the bar is at its cap the moment it
  // resumes and the time counts the ten idle minutes.
  expect(bar).not.toMatch(/ 95%/)
  expect(bar).not.toMatch(/10:00/)
})

test('OK R4.1: a resumed agent keeps one row and runs again; workflow agents keep their own rows', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  engine(on, status)
  await start($)
  await $.agent.spawn(SPAWN)
  status.now = 'completed'
  await $.turn.complete(AGENT_END)
  status.now = 'running'
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2', resume: { agentId: 'a1' } } as never)
  const wf = (i: number) => ({ ...SPAWN, tool_use_id: 'wf', workflow: { runId: 'r', agentIndex: i } })
  await $.agent.spawn(wf(0) as never)
  await $.agent.spawn(wf(1) as never)
  await $.agent.spawn(wf(1) as never)
  const ui = await $.ui.mount(PANE)
  const rows = await ui.findAll({ type: 'Button', text: /Explore/ })
  await ui.unmount()
  expect(rows).toHaveLength(4)
  expect(rows.every(r => /◐|◓|◑|◒/.test(r.text ?? ''))).toBe(true)
})

// ------------------------------------------------------------ R7.2 odd input

for (const [verdict, name, path] of [
  ['BUG R7.2', 'an escape', '/tmp/out\x1b[31mred.txt'],
  ['BUG R2.1/R7.2', 'a newline', '/tmp/two\nlines.txt'],
] as const) {
  test(`${verdict}: a written file whose name holds ${name} does not blank the pane`, async ($, on) => {
    engine(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    // Linux allows any byte but / in a file name; Write succeeds.
    await $.tool.call({ tool: 'Write', file_path: path, content: 'x' })
    const ui = await $.ui.mount(PANE)
    // Actual: the Files row holds the raw name (no plainLine), the Pane refuses the tree.
    expect(await ui.find({ type: 'Text', text: /^Agents/ })).toBeTruthy()
    const row = (await ui.find({ type: 'Text', text: /^ Files / }))?.text ?? ''
    await ui.unmount()
    expect(row).not.toMatch(/[\x00-\x1f]/)
  })
}

for (const [name, ch] of [
  ['a line separator', '\u2028'],
  ['a zero-width space', '\u200b'],
  ['a byte-order mark', '\ufeff'],
  ['a right-to-left override', '\u202e'],
  ['a lone surrogate', '\ud83d'],
] as const) {
  test(`OK R7.2: a command holding ${name} does not blank the pane`, async ($, on) => {
    engine(on)
    await start($)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command: `echo a${ch}b` })
    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ type: 'Text', text: /^Agents/ })).toBeTruthy()
    await ui.unmount()
  })
}

test('OK R5.1/R6.1: an agent edit counts, a prompt clears Files and Done, running agents carry on', async ($, on) => {
  engine(on)
  await start($)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\Repo\\X.ts', old_string: 'a', new_string: 'b', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: 'c:/repo/x.ts' })
  await $.turn.complete(MAIN_END)
  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Files / }))?.text).toMatch(/^ Files    ✎ X\.ts\s*$/)
  expect((await ui.find({ type: 'Text', text: /^ Done / }))?.text).toMatch(/1 (file )?edited/)
  await ui.unmount()
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ (Files|Done) / })).toBeUndefined()
  expect(await ui.findAll({ type: 'Button', text: /Explore/ })).toHaveLength(1)
  await ui.unmount()
})
