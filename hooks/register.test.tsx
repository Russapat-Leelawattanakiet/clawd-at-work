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
// earlier one being completed. `stored` seeds the mod's store. `forked` are
// agents the engine also lists that started with no agent.spawn (a forked
// skill). A command with `exit 1` in it fails.
type Listed = { id: string; description: string; type: string; status: AgentStatus }
const engine = (
  on: On,
  status: { now: AgentStatus } = { now: 'running' },
  stored: Record<string, unknown> = {},
  forked: Listed[] = [],
) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, stored)
  let spawned = 0
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', (_, e) =>
    String((e as { command?: unknown }).command ?? '').includes('exit 1')
      ? { isError: true as const, result: 'failed', text: 'failed' }
      : { result: {} },
  )
  on('agent.spawn', () => ({ agentId: `a${++spawned}`, model: 'test' }))
  on('agent.list', () => ({
    value: [
      ...Array.from({ length: spawned }, (_, i) => ({
        id: `a${i + 1}`,
        description: 'find code',
        type: 'Explore',
        status: i + 1 === spawned ? status.now : ('completed' as const),
      })),
      ...forked.map(a => ({ ...a })),
    ],
  }))
  return clock
}

test('an agent with no agent.spawn (a forked skill) gets a row when its turn starts', async ($, on) => {
  const forked: Listed[] = [{ id: 'f1', type: 'general-purpose', description: 'code review', status: 'running' }]
  engine(on, { now: 'running' }, {}, forked)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.turn.start({ text: 'review', turnId: 'r1', agentId: 'f1' })
  await $.tool.call({ tool: 'Bash', command: 'git diff', agentId: 'f1' })
  let ui = await $.ui.mount(PANE)
  const rows = await ui.findAll({ type: 'Button', text: /general-purpose/ })
  expect(rows).toHaveLength(1)
  expect(rows[0]?.text).toMatch(/◐ general-purpose\s+code review/)
  expect((await ui.find({ type: 'Text', text: /tool/ }))?.text).toMatch(/1 tool$/)
  await ui.unmount()

  // It ends like any other agent.
  forked[0]!.status = 'completed'
  await $.turn.complete({ ...AGENT_END, agentId: 'f1' })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Button', text: /general-purpose/ }))?.text).toMatch(/✓/)
  await ui.unmount()
})

test('the ticker finds forked agents by itself, and never doubles a spawned one', async ($, on) => {
  const forked: Listed[] = [{ id: 'f1', type: 'general-purpose', description: 'code review', status: 'running' }]
  const clock = engine(on, { now: 'running' }, {}, forked)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(SPAWN)

  // A couple of seconds of ticks.
  for (let ms = 250; ms <= 2_500; ms += 250) await clock.set(1_000 + ms)
  const ui = await $.ui.mount(PANE)
  expect(await ui.findAll({ type: 'Button', text: /general-purpose\s+code review/ })).toHaveLength(1)
  expect(await ui.findAll({ type: 'Button', text: /Explore/ })).toHaveLength(1)
  await ui.unmount()
})

test('in a short pane every running agent still shows, one line each', async ($, on) => {
  const forked: Listed[] = [{ id: 'f1', type: 'claude-code-guide', description: 'check the docs', status: 'running' }]
  engine(on, { now: 'running' }, {}, forked)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'two helpers', turnId: 't1' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: ['Read', 'Send helpers', 'Merge', 'Publish'].map((title, i) => ({ content: title, status: i === 1 ? 'in_progress' : 'pending', activeForm: 'Working' })),
  })
  await $.agent.spawn(SPAWN)
  await $.turn.start({ text: '', turnId: 'g1', agentId: 'f1' })

  // 20 rows: the Claude bar, Usage and the plan leave room for one two-row agent.
  const SHORT = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 20 } } }
  const ui = await $.ui.mount(SHORT)
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toBe('Agents   2 running')
  const rows = await ui.findAll({ type: 'Text', text: /^ ◐ (Explore|claude-code-guide) +\d+%/ })
  expect(rows.map(r => r.text.split(' ')[2])).toEqual(['Explore', 'claude-code-guide'])
  expect(rows[1]?.text).toMatch(/check the docs$/)
  await ui.unmount()
})

test('finished agents that do not fit are counted, not silently dropped', async ($, on) => {
  const status: { now: AgentStatus } = { now: 'running' }
  engine(on, status)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const id of ['tu1', 'tu2', 'tu3']) await $.agent.spawn({ ...SPAWN, tool_use_id: id })
  status.now = 'completed'
  await $.turn.complete(AGENT_END)

  const SHORT = { ...PANE, props: { ...PANE.props, scroll: { offset: 0, bodyRows: 14 } } }
  const ui = await $.ui.mount(SHORT)
  // The newest still shows in full; the other two are counted.
  expect(await ui.findAll({ type: 'Button', text: /Explore/ })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /^ \+2 more finished$/ })).toBeTruthy()
  await ui.unmount()
})

test('one file written two ways on Windows is listed once', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\Notes.md' })
  await $.tool.call({ tool: 'Edit', file_path: 'c:/repo/notes.md', old_string: 'x', new_string: 'y' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Files / }))?.text).toMatch(/^ Files    ✎ Notes\.md\s*$/)
  await ui.unmount()
})

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
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read the code', status: 'completed', activeForm: 'Working' },
      { content: 'Add the plan tool', status: 'in_progress', activeForm: 'Working' },
      { content: 'Write tests', status: 'pending', activeForm: 'Working' },
      { content: 'Run the checks', status: 'pending', activeForm: 'Working' },
    ],
  })
  // 15 s into the active step, half its 30 s default: steps read 100, 50, 0
  // and 0%, so the Claude bar shows their mean, 38%.
  await clock.set(1_000 + 15_000)
  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Plan / }))?.text).toMatch(/1\/4 steps done/)
  expect((await ui.find({ type: 'Text', text: /Read the code/ }))?.text).toMatch(/^  ✓ Read the code$/)
  // At 40 columns a title still shows whole; the active step's bar is beneath it.
  expect((await ui.find({ type: 'Text', text: /Add the plan tool/ }))?.text).toMatch(/Add the plan tool$/)
  const bar = (await ui.find({ type: 'Text', text: /^ {4}━*(▛█▜|▜█▛)/ }))?.text
  expect(bar).toMatch(/ 50%  0:15$/)
  expect((await ui.find({ type: 'Text', text: /Write tests/ }))?.text).toMatch(/^  ○ Write tests$/)
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/ 38%/)
  expect(await ui.find({ type: 'Text', text: /Overall/ })).toBeUndefined()
  await ui.unmount()

  // Every step done: the bars reach 100%.
  await $.tool.call({
    tool: 'TodoWrite',
    todos: ['Read the code', 'Add the plan tool', 'Write tests', 'Run the checks'].map(content => ({
      content,
      status: 'completed',
      activeForm: 'Working',
    })),
  })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/100%/)
  await ui.unmount()

  // A title too long for the pane uses its whole width before it is cut.
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Check the pane loads the edited mod from the local folder', status: 'completed', activeForm: 'Working' }],
  })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /Check the pane/ }))?.text).toBe('  ✓ Check the pane loads the edited mod…')
  await ui.unmount()

  // A new prompt clears the plan.
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^ Plan / })).toBeUndefined()
  await ui.unmount()
})

test('the mod adds nothing the model reads, so it costs no tokens', async ($, on) => {
  engine(on)
  let registered = 0
  on('tool.register', () => {
    registered += 1
    return { value: { tool: 'unexpected' } }
  })
  const base = [{ id: 'base', text: 'The prompt as the engine composed it.', scope: 'shared' as const }]
  on('prompt.compose', () => ({ sections: base }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(registered).toBe(0)
  expect((await $.prompt.compose({} as never)).sections).toEqual(base)
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
  expect((await ui.find({ type: 'Text', text: /Read settings/ }))?.text).toMatch(/✓ Read settings\.json ×2$/)
  expect((await ui.find({ type: 'Text', text: /Run merge/ }))?.text).toMatch(/✓ Run merge\.js$/)
  // No plan was declared, so the Claude bar keeps its time estimate.
  expect((await ui.find({ type: 'Text', text: /^ Claude / }))?.text).toMatch(/ 3%/)
  await ui.unmount()

  // A declared plan takes over from the auto steps.
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Ship it', status: 'in_progress', activeForm: 'Working' }] })
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

test('a command that starts by changing folder shows the work after it', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'test it', turnId: 't1' })

  await $.tool.call({ tool: 'Bash', command: 'cd "C:/Users/me/Desktop/my repo" && npm test' })
  await $.tool.call({ tool: 'PowerShell', command: 'Set-Location C:\\repo; git status' })
  await $.tool.call({ tool: 'Bash', command: 'cd /home/me/project/' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
  expect(await ui.find({ type: 'Text', text: /Run tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Check git status/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Run cd project/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Users/ })).toBeUndefined()
  await ui.unmount()
})

test('paths inside a command are cut to their last name', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'test it', turnId: 't1' })

  await $.tool.call({ tool: 'Bash', command: 'mytool marketplace add "C:\\Users\\me\\Desktop\\my repo"' })
  await $.tool.call({ tool: 'Bash', command: 'mytool -c x ~/.claude/plugins/cache/mod/hooks/register.tsx' })
  await $.tool.call({ tool: 'Bash', command: 'mytool origin/main hooks/a.ts /d' })
  await $.tool.call({ tool: 'Bash', command: 'mytool https://x.com/a/b/c src/**/*.ts' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 80 } })
  expect(await ui.find({ type: 'Text', text: /Run mytool marketplace add "my repo"/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Run mytool -c x register\.tsx/ })).toBeDefined()
  // Short paths, URLs, globs and flags are left as they are.
  expect(await ui.find({ type: 'Text', text: /Run mytool origin\/main hooks\/a\.ts \/d/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Run mytool https:\/\/x\.com\/a\/b\/c src\/\*\*\/\*\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Users|\.claude/ })).toBeUndefined()
  await ui.unmount()
})

// A shell call reads as plain words, not as the command it ran.
for (const [command, title] of [
  ['git status --short', 'Check git status'],
  ['git -C "C:/a b/repo" log --oneline -3', 'Read git history'],
  ['git branch -d old', 'Check branches'],
  ['git cherry-pick abc', 'Run git cherry-pick'],
  // A chain is named after its most telling command, with a count of the rest.
  ['git add a.ts && git commit -m "fix" && git push', 'Push changes +2'],
  [
    'cd "C:/Users/me/my repo" && git status --short 2>/dev/null; git remote -v; git fetch origin 2>&1 | tail -2; claude plugin test . 2>&1 | grep -E "a|b"',
    'Run tests +3',
  ],
  // Plumbing in a chain is not counted, and only a pipe's first command is.
  ['echo "--- tests"; npm run test -- --watch', 'Run tests'],
  ['grep -rn "a|b" hooks | head -5', 'Search files'],
  ['$p = "x"; Remove-Item $p -Force', 'Delete files'],
  ['FOO=1 sudo npm install', 'Install packages'],
  // Separators inside quotes and heredocs do not split a command.
  ['git commit -m "fix: a; b && git push"', 'Commit changes'],
  ["git add a.ts && git commit -q -F - <<'EOF'\nfix: a; b && c\n\ngit push\nEOF\ngit push -u origin x", 'Push changes +2'],
  // Files and scripts read by name, a download by its host.
  ['python -I "C:/Users/me/scratch/audit.py" "$HOME/x"', 'Run audit.py'],
  ['python -c "print(1)"', 'Run inline code'],
  ['cat C:/repo/package.json', 'Read package.json'],
  ["cat > C:/repo/out.txt <<'EOF'\nhello\nEOF", 'Write out.txt'],
  ["sed -n '1,5p' a.md", 'Read file'],
  ['sed -i s/a/b/ a.md', 'Edit file'],
  ['npm run dev', 'Run dev script'],
  ['npx vite build', 'Build project'],
  ['curl -s https://www.example.com/a/b/c?d=1 -o f', 'Download from example.com'],
  ['Get-ChildItem -Recurse C:\\repo', 'List files'],
] as const) {
  test(`a shell call reads "${title}": ${command.split('\n')[0]!.slice(0, 50)}`, async ($, on) => {
    engine(on)
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: 'Bash', command })
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
    const rows = (await ui.findAll({ type: 'Text', text: /^ {2}\S / })).map(t => t.text.slice(4))
    await ui.unmount()
    expect(rows).toContain(title)
  })
}

test('a shell call no template names uses its description, then its cleaned command', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  const command = 'for f in a b; do mytool $f; done'
  await $.tool.call({ tool: 'Bash', command, description: 'Convert each chart' } as never)
  let ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
  expect(await ui.find({ type: 'Text', text: /^ {2}\S Convert each chart$/ })).toBeTruthy()
  // The line under the Claude bar says the same, with no "Running" in front.
  expect(await ui.find({ type: 'Text', text: /Running Convert/ })).toBeUndefined()
  await ui.unmount()

  await $.tool.call({ tool: 'Bash', command: 'mytool --go C:\\Users\\me\\a\\b.txt' })
  ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
  expect(await ui.find({ type: 'Text', text: /^ {2}\S Run mytool --go b\.txt$/ })).toBeTruthy()
  await ui.unmount()
})

test('a template wins over the description, and repeats of it merge', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'grep -c one a.md', description: 'Count the ones' } as never)
  await $.tool.call({ tool: 'Bash', command: 'grep -c two b.md', description: 'Count the twos' } as never)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
  expect(await ui.find({ type: 'Text', text: /^ {2}\S Search files ×2$/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /Count the/ })).toBeUndefined()
  await ui.unmount()
})

// Other tools' long names and inputs read as plain words too.
for (const [input, title] of [
  [{ tool: 'mcp__claude_ai_Google_Drive__get_file_permissions', fileId: 'x' }, 'Google Drive: get file permissions'],
  [{ tool: 'mcp__claude_ai_Atlassian_Rovo__searchJiraIssuesUsingJql', jql: 'x' }, 'Atlassian Rovo: search jira issues using jql'],
  [{ tool: 'mcp__claude_ai_Notion__notion-create-pages', pages: [] }, 'Notion: create pages'],
  [{ tool: 'mcp__plugin_design_figma__authenticate' }, 'figma: authenticate'],
  [{ tool: 'SomeUnknownTool' }, 'Some unknown tool'],
  [{ tool: 'EnterPlanMode' }, 'Start planning'],
  [{ tool: 'Grep', pattern: 'additionalContext|systemMessage|hookOutput' }, 'Search additionalContext +2'],
  [{ tool: 'Grep', pattern: 'TODO\\|FIXME' }, 'Search TODO +1'],
  [{ tool: 'Grep', pattern: '\\bfunction\\s+\\w+' }, 'Search function'],
  [{ tool: 'Grep', pattern: '^\\s*$' }, 'Search a pattern'],
  [{ tool: 'Grep', pattern: 'usage' }, 'Search usage'],
  [{ tool: 'Glob', pattern: 'src/**/*.ts' }, 'Find files src/**/*.ts'],
  [{ tool: 'WebFetch', url: 'https://www.docs.example.com/a/very/long/path/to/page.html?x=1' }, 'Fetch docs.example.com'],
] as const) {
  test(`a ${input.tool} call reads "${title}"`, async ($, on) => {
    engine(on)
    on('turn.start', (_, e) => ({ turnId: e.turnId }))
    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call(input as never)
    const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 60 } })
    const rows = (await ui.findAll({ type: 'Text', text: /^ {2}\S / })).map(t => t.text.slice(4))
    await ui.unmount()
    expect(rows).toContain(title)
  })
}

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

  // A main-loop tool call becomes the activity, in plain words, with its target.
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\notes.md' })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /notes\.md  step/ }))?.text).toMatch(
    /Reading notes\.md\s+step 0 · 1 tool$/,
  )
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
  const plan = (first: 'pending' | 'in_progress' | 'completed', second: 'pending' | 'in_progress' | 'completed') =>
    $.tool.call({
      tool: 'TodoWrite',
      todos: [
        { content: 'One', status: first, activeForm: 'Working' },
        { content: 'Two', status: second, activeForm: 'Working' },
      ],
    })

  // Step One is active for 10 s, then done.
  await plan('in_progress', 'pending')
  await clock.set(1_000 + 10_000)
  await plan('completed', 'in_progress')

  // 5 s into step Two reads 50% of the learned 10 s, not 17% of 30 s.
  await clock.set(1_000 + 15_000)
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ {4}━*(▛█▜|▜█▛)/ }))?.text).toMatch(/ 50%  0:05$/)
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

test('under a declared plan, Recent lists the latest calls and marks a failed one', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'fix it', turnId: 't1' })

  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Fix it', status: 'in_progress', activeForm: 'Working' }] })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\notes.md' })
  await $.tool.call({ tool: 'Bash', command: 'exit 1' })
  const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 60 } }
  let ui = await $.ui.mount(WIDE)
  // TodoWrite itself is not an action in the feed.
  expect((await ui.find({ type: 'Text', text: /^ Recent / }))?.text).toMatch(/2 actions$/)
  expect((await ui.find({ type: 'Text', text: /Read notes\.md/ }))?.text).toMatch(/^  ▤ Read notes\.md\s+\d+\.\ds$/)
  expect((await ui.find({ type: 'Text', text: /Run exit 1/ }))?.text).toMatch(/^  ✗ Run exit 1/)
  await ui.unmount()

  // Without a plan the Steps list already shows each action, so no Recent.
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\notes.md' })
  ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /^ Recent / })).toBeUndefined()
  await ui.unmount()
})

test('Clawd shows what kind of work it is doing, a snag, and a cheer at the end', async ($, on) => {
  const clock = engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const labelIs = async (word: RegExp) => {
    const ui = await $.ui.mount(PANE)
    const found = await ui.find({ type: 'Text', text: word })
    const props = await ui.findAll({ type: 'Text', text: /\S/ })
    await ui.unmount()
    return { found, props: props.map(t => t.text) }
  }

  await $.turn.start({ text: 'look', turnId: 't1' })
  expect((await labelIs(/^thinking$/)).found).toBeTruthy()

  // Searching: the word, and the magnifier beside Clawd.
  await $.tool.call({ tool: 'Grep', pattern: 'usage' })
  const searching = await labelIs(/^searching$/)
  expect(searching.found).toBeTruthy()
  expect(searching.props.some(t => /^ ?⌕ *$/.test(t))).toBe(true)

  // A question for the person: Claude waits on them.
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which one?',
        header: 'Pick',
        multiSelect: false,
        options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ],
      },
    ],
  })
  expect((await labelIs(/^waiting for you$/)).found).toBeTruthy()

  // A failed command is a snag for a few seconds, then just the work again.
  await $.tool.call({ tool: 'Bash', command: 'exit 1' })
  expect((await labelIs(/^hit a snag$/)).found).toBeTruthy()
  await clock.set(1_000 + 3_000)
  expect((await labelIs(/^running a command$/)).found).toBeTruthy()

  // The turn ends: Clawd cheers, then rests.
  await $.turn.complete({ answer: '', durationMs: 3_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect((await labelIs(/^done!$/)).found).toBeTruthy()
  await clock.set(1_000 + 3_000 + 4_000)
  expect((await labelIs(/^resting/)).found).toBeTruthy()
})

test('Files lists what was edited and read, and Done sums up the turn', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'change it', turnId: 't1' })

  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\a.md' })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\repo\\b.ts', old_string: 'x', new_string: 'y' })
  // An agent's edit is listed; an agent's read is not.
  await $.agent.spawn(SPAWN)
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\repo\\c.ts', old_string: 'x', new_string: 'y', agentId: 'a1' })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\d.md', agentId: 'a1' })
  const WIDE = { ...PANE, props: { ...PANE.props, bodyColumns: 60 } }
  let ui = await $.ui.mount(WIDE)
  const row = (await ui.find({ type: 'Text', text: /^ Files / }))?.text
  expect(row).toMatch(/^ Files    ✎ b\.ts  ✎ c\.ts  ◦ a\.md/)
  expect(row).not.toMatch(/d\.md/)
  // While the turn runs there is no Done line.
  expect(await ui.find({ type: 'Text', text: /^ Done / })).toBeUndefined()
  await ui.unmount()

  await $.turn.complete({ answer: '', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' })
  ui = await $.ui.mount(WIDE)
  expect((await ui.find({ type: 'Text', text: /^ Done / }))?.text).toBe(' Done     ✓ 0:30 · 2 files edited · 2 tools')
  await ui.unmount()

  // The next prompt starts over.
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  ui = await $.ui.mount(WIDE)
  expect(await ui.find({ type: 'Text', text: /^ (Files|Done) / })).toBeUndefined()
  await ui.unmount()
})

const HOUR = 60 * 60 * 1000
const at = (ms: number) => new Date(1_000 + ms).toISOString()
const TOKENS = { input_tokens: 1_000, output_tokens: 500, cache_read_input_tokens: 8_000, cache_creation_input_tokens: 500 }
const MAIN_END = { answer: '', durationMs: 5, isAborted: false, turnId: 't', reason: 'answer' } as const

test('usage shows the session and week limits and when each resets', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /no limit reading yet/ })).toBeTruthy()
  await ui.unmount()

  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'seven_day', percentUsed: 92, resetsAt: at(3 * 24 * HOUR + 4 * HOUR) },
      { kind: 'five_hour', percentUsed: 42.5, resetsAt: at(2 * HOUR + 14 * 60_000) },
    ],
    cost: { usd: 1.234 },
    changed: ['rateLimits', 'cost'],
  })
  ui = await $.ui.mount(PANE)
  const rows = await ui.findAll({ type: 'Text', text: /^ (Session|Week) .*%/ })
  // The session window comes first, whatever order the engine sent.
  expect(rows[0]?.text).toMatch(/^ Session .* 43%  resets in 2h 14m$/)
  expect(rows[1]?.text).toMatch(/^ Week .* 92%  resets in 3d 4h$/)
  expect((await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text).toMatch(/\$1\.23$/)
  await ui.unmount()

  // A minute later the countdown has moved.
  await clock.set(1_000 + 60_000)
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Session .*%/ }))?.text).toMatch(/resets in 2h 13m$/)
  await ui.unmount()
})

test('turns count tokens for the session and the week, which resets with its window', async ($, on) => {
  const clock = engine(on, { now: 'running' }, { 'week-tokens': { tokens: 40_000, resetsAt: at(5_000) } })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // A main turn and an agent's turn: 10k tokens each, on top of the week's 40k.
  await $.turn.complete({ ...MAIN_END, usage: { ...TOKENS, model: 'test' } })
  await $.turn.complete({ ...AGENT_END, usage: { ...TOKENS, model: 'test' } })
  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text).toBe(' Tokens   20.0k session · 60.0k week')
  await ui.unmount()

  // Past the week's reset, the week count starts over; the session's goes on.
  await clock.set(1_000 + 10_000)
  await $.turn.complete({ ...MAIN_END, usage: { ...TOKENS, model: 'test' } })
  ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Tokens/ }))?.text).toBe(' Tokens   30.0k session · 10.0k week')
  await ui.unmount()
})

test('a turn an API error ended reads Failed, and Clawd does not cheer', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'error' })
  const ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^ Failed / }))?.text).toMatch(/^ Failed   ✗ 0:02/)
  expect(await ui.find({ type: 'Text', text: /^done!$/ })).toBeUndefined()
  await ui.unmount()
})

test('other sessions in the same project are listed under Sessions', async ($, on) => {
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
  const clock = engine(on, { now: 'running' }, {
    'session:p1': peer('p1', String.raw`C:\repo`, 'fix the login bug'),
    // A session in a worktree reports its repository's main root, so it is the same project.
    'session:p2': peer('p2', 'c:/repo/', 'write docs', { state: 'waiting', activity: '' }),
    'session:p3': peer('p3', String.raw`C:\other`, 'another project'),
    'session:p4': peer('p4', String.raw`C:\repo`, 'long gone', { updatedAt: 1_000 - 61_000 }),
  })
  on('session.id', () => ({ value: 'me' }))
  // The engine reports no git repository here, so the folder is the project.
  on('session.repo', () => ({ value: null }))
  await $.session.start({ cwd: 'c:/Repo', surface: 'terminal', isInteractive: true })
  for (let ms = 250; ms <= 2_500; ms += 250) await clock.set(1_000 + ms)

  let ui = await $.ui.mount(PANE)
  expect((await ui.find({ type: 'Text', text: /^Sessions/ }))?.text).toMatch(/^Sessions   2 working$/)
  expect((await ui.find({ type: 'Text', text: /fix the login bug/ }))?.text).toMatch(/^  . fix the login bug\s+40%$/)
  expect(await ui.find({ type: 'Text', text: /^ {4}Running npm test$/ })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /write docs/ }))?.text).toMatch(/^  \? write docs/)
  expect(await ui.find({ type: 'Text', text: /another project|long gone/ })).toBeUndefined()
  await ui.unmount()

  // Sessions that stop reporting drop off within a minute.
  for (let ms = 62_000; ms <= 64_000; ms += 250) await clock.set(1_000 + ms)
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /^Sessions/ })).toBeUndefined()
  await ui.unmount()
})

test('a session publishes what it is doing for the others, and takes it back when it ends', async ($, on) => {
  // A store of the test's own, to read what the mod publishes.
  const kept = new Map<string, unknown>()
  const clock = mock.clock(on, { now: 1_000 })
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
  on('session.id', () => ({ value: 'me' }) as never)
  on('session.repo', () => ({ value: { root: '/home/me/repo', remote: null, internal: false } }) as never)
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('session.end', () => ({ sessionId: 'me' }) as never)

  // Started in a worktree: the project is the repository's main root.
  await $.session.start({ cwd: '/home/me/repo/.claude/worktrees/w1', surface: 'terminal', isInteractive: true })
  await $.prompt.submit({ text: 'fix the login bug\nand add a test', wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'fix the login bug', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  for (let ms = 250; ms <= 2_500; ms += 250) await clock.set(1_000 + ms)
  expect(kept.get('session:me')).toMatchObject({
    id: 'me',
    cwd: '/home/me/repo',
    task: 'fix the login bug',
    state: 'working',
    activity: 'Running tests',
  })

  await $.session.end({ reason: 'other' } as never)
  expect(kept.has('session:me')).toBe(false)
})
