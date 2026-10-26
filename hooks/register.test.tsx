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
    scroll: { offset: 0, bodyRows: 20 },
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

// Stand-ins for the engine beneath the plugin. Spawns answer a1, a2, ...;
// `status.now` is what `$.agent.list()` reports for the newest agent, every
// earlier one being completed.
const engine = (on: On, status: { now: AgentStatus } = { now: 'running' }) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on)
  let spawned = 0
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__clawd-at-work__plan' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
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

test('idle pane shows the resting mascot and empty lists', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /resting/ })).toBeTruthy()
  expect((await ui.findAll({ type: 'Text', text: /none yet/ })).length).toBe(2)
  await ui.unmount()
})

test('a Skill call is listed as running until its turn ends', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Skill', skill: 'plugin-authoring' })
  const ui = await $.ui.mount(PANE)
  // The Skills row (the Steps list also has a "Load skill" line for it).
  expect((await ui.find({ type: 'Text', text: /^ \S plugin-authoring/ }))?.text).toMatch(/◐/)
  await ui.unmount()
})

test('an agent row shows an estimated bar that ends at 100%', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  const clock = engine(on, status)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  // Explore's default typical time is 45 s: half of it reads as 50%.
  await clock.set(1_000 + 22_500)
  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toMatch(/ 50%/)
  await ui.unmount()

  // Past the typical time the estimate holds at 95% until the agent ends.
  await clock.set(1_000 + 90_000)
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toMatch(/ 95%/)
  await ui.unmount()

  status.now = 'completed'
  await $.turn.complete(AGENT_END)
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /Explore/ }))?.text).toMatch(/✓/)
  expect((await ui.find({ type: 'Text', text: /%/ }))?.text).toMatch(/100%/)
  await ui.unmount()
})

test('each agent bar has a tiny 3-character mini Clawd in its own color', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2' })
  const ui = await $.ui.mount(PANE)
  // The face is its own Text on the bar, exactly one of the two running frames.
  const bodies = (await ui.findAll({ type: 'Text', text: /▛█▜|▜█▛/ })).filter(t =>
    /^(▛█▜|▜█▛)$/.test(t.text),
  )
  expect(bodies.length).toBe(2)
  expect(bodies[0]?.props.color).not.toBe(bodies[1]?.props.color)
  // No legs: nothing is drawn on a row of its own below the bar.
  expect(await ui.findAll({ type: 'Text', text: /▘▘▝▝|▝▝▘▘/ })).toHaveLength(0)
  await ui.unmount()
})

test('a new prompt clears finished rows and keeps running agents', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  engine(on, status)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // a1 finishes at 100%, a2 is still running, and a skill has finished.
  await $.agent.spawn(SPAWN)
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2', description: 'still going' })
  await $.tool.call({ tool: 'Skill', skill: 'old-skill' })
  await $.turn.complete({ ...AGENT_END, agentId: undefined })
  await $.turn.complete(AGENT_END)

  await $.prompt.submit({ text: 'next task', wait: false, origin: { kind: 'composer' } })
  const ui = await $.ui.mount(PANE)
  const rows = await ui.findAll({ type: 'Button', text: /Explore/ })
  expect(rows.length).toBe(1)
  expect(rows[0]?.text).toMatch(/still going/)
  expect(await ui.find({ type: 'Text', text: /old-skill/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /100%/ })).toBeUndefined()
  // There is no Overall bar any more.
  expect(await ui.find({ type: 'Text', text: /Overall/ })).toBeUndefined()
  await ui.unmount()
})

test('each plan step has its own bar and they drive the Claude bar', async ($, on) => {
  const clock = engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'build it', turnId: 't1' })

  // One step done, one active, two pending.
  const ran = await $.tool.call({
    tool: 'mcp__clawd-at-work__plan',
    steps: [
      { title: 'Read the code', status: 'done' },
      { title: 'Add the plan tool', status: 'active' },
      { title: 'Write tests', status: 'pending' },
      { title: 'Run the checks', status: 'pending' },
    ],
  })
  expect(ran.text).toBe('Plan shown: 1/4 steps done.')
  // The engine takes only text as a registered tool's result.
  expect(typeof ran.result).toBe('string')
  // 15 s into the active step, half its 30 s default: steps read 100, 50, 0
  // and 0%, so the Claude bar shows their mean, 38%.
  await clock.set(1_000 + 15_000)
  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Plan / }))?.text).toMatch(/1\/4 steps done/)
  expect((await ui.find({ type: 'Text', text: /Read the code/ }))?.text).toMatch(/✓ Read the code\s+━+\s+100%$/)
  // At 40 columns a long title is cut to fit beside its bar.
  const active = (await ui.find({ type: 'Text', text: /Add the plan…/ }))?.text
  expect(active).toMatch(/▛█▜|▜█▛/)
  expect(active).toMatch(/ 50%$/)
  expect((await ui.find({ type: 'Text', text: /Write tests/ }))?.text).toMatch(/○ Write tests\s+─+\s+0%$/)
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/ 38%/)
  expect(await ui.find({ type: 'Text', text: /Overall/ })).toBeUndefined()
  await ui.unmount()

  // Every step done: the bars reach 100%.
  await $.tool.call({
    tool: 'mcp__clawd-at-work__plan',
    steps: ['Read the code', 'Add the plan tool', 'Write tests', 'Run the checks'].map(title => ({
      title,
      status: 'done',
    })),
  })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/100%/)
  await ui.unmount()

  // A new prompt clears the plan.
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ Plan / })).toBeUndefined()
  await ui.unmount()
})

test('a TodoWrite list shows as the plan', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'First', status: 'completed', activeForm: 'Doing first' },
      { content: 'Second', status: 'in_progress', activeForm: 'Doing second' },
    ],
  })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Plan / }))?.text).toMatch(/1\/2 steps done/)
  await ui.unmount()
})

test('without a declared plan, real actions become auto steps', async ($, on) => {
  const clock = engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'fix it', turnId: 't1' })

  // Two reads of the same file merge into one step; a command is a new one.
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\settings.json' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\settings.json' })
  await clock.set(1_000 + 2_000)
  await $.tool.call({ tool: 'Bash', command: 'node merge.js' })
  // 60 columns, so the titles and their ×2 are not cut short.
  const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 60 } }
  let ui = await $.ui.mount(WIDE)
  expect((await ui.find({ type: 'Text', text: /^ Steps / }))?.text).toMatch(/2 done · auto/)
  expect((await ui.find({ type: 'Text', text: /Read settings/ }))?.text).toMatch(/✓ Read settings.*×2.*100%$/)
  expect((await ui.find({ type: 'Text', text: /Run node/ }))?.text).toMatch(/✓ Run node merge\.js.*100%$/)
  // No plan was declared, so the Claude bar keeps its time estimate.
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/ 3%/)
  await ui.unmount()

  // A declared plan takes over from the auto steps.
  await $.tool.call({ tool: 'mcp__clawd-at-work__plan', steps: [{ title: 'Ship it', status: 'active' }] })
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ Steps / })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /^ Plan / }))?.text).toMatch(/0\/1 steps done/)
  await ui.unmount()

  // A new prompt clears both.
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ (Steps|Plan) / })).toBeUndefined()
  await ui.unmount()
})

test('the Claude bar shows the main turn and what Claude is doing', async ($, on) => {
  const clock = engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Idle: no Claude bar.
  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ Claude / })).toBeUndefined()
  await ui.unmount()

  // A main turn starts thinking; halfway through the 60 s default it is 50%.
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await clock.set(1_000 + 30_000)
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/ 50%/)
  expect(await ui.find({ type: 'Text', text: /thinking…/ })).toBeTruthy()
  await ui.unmount()

  // A main-loop tool call becomes the activity, with its target.
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\notes.md' })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /notes\.md/ }))?.text).toMatch(/Read\s+notes\.md\s+step 0 · 1 tool$/)
  await ui.unmount()

  // The turn ends: the bar goes away.
  await $.turn.complete({ answer: '', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' })
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ Claude / })).toBeUndefined()
  await ui.unmount()
})

test('a finished agent runner closes its eyes', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // a1 finishes once a2 has started, so a1 reads completed.
  await $.agent.spawn(SPAWN)
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2' })
  await $.turn.complete(AGENT_END)
  const ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^▀█▀$/ })).toBeTruthy()
  await ui.unmount()
})

test('a finished step teaches the typical step time', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const plan = (first: string, second: string) =>
    $.tool.call({
      tool: 'mcp__clawd-at-work__plan',
      steps: [
        { title: 'One', status: first },
        { title: 'Two', status: second },
      ],
    })

  // Step One is active for 10 s, then done.
  await plan('active', 'pending')
  await clock.set(1_000 + 10_000)
  await plan('done', 'active')

  // 5 s into step Two reads 50% of the learned 10 s, not 17% of 30 s.
  await clock.set(1_000 + 15_000)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Two/ }))?.text).toMatch(/ 50%$/)
  await ui.unmount()
})

test('tool calls inside the agent are counted on its row', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Bash', command: 'ls', agentId: 'a1' })
  await $.tool.call({ tool: 'Bash', command: 'pwd', agentId: 'a1' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /tools/ }))?.text).toMatch(/2 tools/)
  await ui.unmount()
})

test('an agent row opens a dropdown of its tool calls', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\src\\main\\catalog.js', agentId: 'a1' })
  await $.tool.call({ tool: 'Grep', pattern: 'library:list', agentId: 'a1' })

  // Closed by default: the row says ▸ and no tool lines are drawn.
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', key: 'agent-tu1' }))?.text).toMatch(/^▸/)
  expect(await ui.find({ type: 'Text', text: /catalog\.js/ })).toBeUndefined()

  // Pressing the row opens it: each call with its target, path cut to the file.
  await ui.press({ key: 'agent-tu1' })
  expect((await ui.find({ type: 'Button', key: 'agent-tu1' }))?.text).toMatch(/^▾/)
  expect((await ui.find({ type: 'Text', text: /Read/ }))?.text).toMatch(/✓ Read\s+catalog\.js/)
  expect((await ui.find({ type: 'Text', text: /Grep/ }))?.text).toMatch(/library:list/)

  // Pressing again folds it back up.
  await ui.press({ key: 'agent-tu1' })
  expect(await ui.find({ type: 'Text', text: /catalog\.js/ })).toBeUndefined()
  await ui.unmount()
})

test('a finished run teaches the typical time for its type', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  const clock = engine(on, status)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // The first Explore run takes 10 s...
  await $.agent.spawn(SPAWN)
  await clock.set(1_000 + 10_000)
  status.now = 'completed'
  await $.turn.complete(AGENT_END)

  // ...so 5 s into the next one reads as 50%, not the 45 s default's 11%.
  status.now = 'running'
  await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu2' })
  await clock.set(1_000 + 15_000)
  const ui = await $.ui.mount(PANE)
  const bars = await ui.findAll({ type: 'Text', text: /%/ })
  expect(bars.at(-1)?.text).toMatch(/ 50%/)
  await ui.unmount()
})
