import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Other Claude Code sessions on this computer, shown under Agents: read from
// the records under <claude folder>/sessions and their transcripts and
// subagent logs, whether or not those sessions run this mod.

const pane = (bodyColumns: number, bodyRows: number) =>
  ({
    plugin: 'clawd-at-work',
    component: 'Pane',
    requestId: 'clawd-at-work',
    surface: 'terminal',
    props: {
      title: 'Claude at work',
      isFocused: false,
      bodyColumns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows },
      view: {},
    },
  }) as const

const HOME = '/home/me/.claude'
const PROJECT = `${HOME}/projects/-work-genome`

type File = { text: string; mtimeMs: number }

const line = (value: unknown) => `${JSON.stringify(value)}\n`
const call = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  line({
    type: 'assistant',
    timestamp: '1970-01-01T00:00:01.000Z',
    message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'x', name, input }] },
    ...extra,
  })

// The files a computer with three other sessions holds: p1 works and runs an
// Explore agent (one more finished), p2 waits on a permission prompt, p3
// rests with nothing running. `me` is this session's own record.
const computer = (): Record<string, File> => ({
  [`${HOME}/sessions/111.json`]: {
    text: JSON.stringify({ sessionId: 'p1', cwd: '/work/genome', name: 'genome-m6-mvp-999d414c-25', status: 'busy', statusUpdatedAt: 1_000 }),
    mtimeMs: 1_000,
  },
  [`${HOME}/sessions/111.6f2a.key`]: { text: '{"peerToken":"secret"}', mtimeMs: 1_000 },
  [`${HOME}/sessions/222.json`]: {
    text: JSON.stringify({
      sessionId: 'p2',
      cwd: '/work/genome',
      name: 'genome-m6-mvp-999d414c-0e',
      status: 'waiting',
      waitingFor: 'approve Bash',
      statusUpdatedAt: 1_000,
    }),
    mtimeMs: 1_000,
  },
  [`${HOME}/sessions/333.json`]: {
    text: JSON.stringify({ sessionId: 'p3', cwd: '/work/genome', name: 'genome-m6-mvp-999d414c-2a', status: 'idle', statusUpdatedAt: 1_000 }),
    mtimeMs: 1_000,
  },
  [`${HOME}/sessions/444.json`]: {
    text: JSON.stringify({ sessionId: 'me', cwd: '/home/me/repo', name: 'clawd-at-work-d5', status: 'busy', statusUpdatedAt: 1_000 }),
    mtimeMs: 1_000,
  },
  [`${PROJECT}/p1.jsonl`]: {
    text: line({ type: 'user', message: { role: 'user', content: 'run the suite' } }) + call('Read', { file_path: '/work/genome/parser.py' }),
    mtimeMs: 20_000,
  },
  [`${PROJECT}/p1/subagents/agent-a9.jsonl`]: {
    text: line({ type: 'user', timestamp: '1970-01-01T00:00:01.000Z', message: { role: 'user', content: 'go' } }) +
      call('Grep', { pattern: 'parse' }) +
      call('Read', { file_path: '/work/genome/lexer.py' }),
    mtimeMs: 25_000,
  },
  [`${PROJECT}/p1/subagents/agent-a9.meta.json`]: {
    text: JSON.stringify({ agentType: 'Explore', description: 'find the parser tests' }),
    mtimeMs: 1_000,
  },
  [`${PROJECT}/p1/subagents/agent-a8.jsonl`]: {
    text: call('Bash', { command: 'pytest' }) + call('SubagentHandback', { summary: 'done' }),
    mtimeMs: 20_000,
  },
  [`${PROJECT}/p1/subagents/agent-a8.meta.json`]: {
    text: JSON.stringify({ agentType: 'general-purpose', description: 'review the fix' }),
    mtimeMs: 1_000,
  },
})

// The engine hands paths over made absolute for this computer (C:\home\me\...):
// back to the disk's own spelling.
const disk = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// The engine beneath the mod, with `files` as the computer's disk. Each read
// path is noted in `reads`.
const engine = (on: On, files: Record<string, File>, reads: string[] = [], stored: Record<string, unknown> = {}) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.store(on, stored)
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } as never }))
  on('session.id', () => ({ value: 'me' }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('session.info', () => ({ value: { transcriptPath: `${HOME}/projects/-home-me-repo/me.jsonl` } }) as never)
  on('agent.list', () => ({ value: [] }))
  on('fs.list', (_, e) => {
    const prefix = `${disk(e.path)}/`
    const names = Object.keys(files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    if (names.length === 0 && !Object.keys(files).some(p => p.startsWith(prefix))) throw new Error('ENOENT')
    return {
      value: names.map(p => ({
        name: p.slice(prefix.length),
        kind: 'file' as const,
        size: files[p]!.text.length,
        mtimeMs: files[p]!.mtimeMs,
        isLink: false,
      })),
    }
  })
  on('fs.stat', (_, e) => {
    const file = files[disk(e.path)]
    if (!file) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', (_, e) => {
    const file = files[disk(e.path)]
    if (!file) throw new Error('ENOENT')
    reads.push(disk(e.path))
    const offset = e.offset ?? 0
    return { value: file.text.slice(offset, e.length === undefined ? undefined : offset + e.length) }
  })
  return clock
}

const settle = async (clock: { set: (ms: number) => Promise<unknown> }, until = 31_000, from = 1_250) => {
  for (let ms = from; ms <= until; ms += 250) await clock.set(ms)
}

test('other sessions show under Agents: their name, state, bar and running subagents', async ($, on) => {
  const reads: string[] = []
  const clock = engine(on, computer(), reads)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  const ui = await $.ui.mount(pane(60, 80))
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toMatch(/^Agents\s+1 in other sessions$/)
  // The one waiting for the person comes first, with what it waits for.
  expect((await ui.find({ type: 'Text', text: /genome-m6-mvp-999d414c-0e/ }))?.text).toMatch(
    /^ [! ] genome-m6-mvp-999d414c-0e {2}needs you$/,
  )
  expect(await ui.find({ type: 'Text', text: /^ {4}approve Bash$/ })).toBeDefined()
  // The working one: its bar, time and last action.
  expect((await ui.find({ type: 'Text', text: /genome-m6-mvp-999d414c-25/ }))?.text).toMatch(
    /^ \S genome-m6-mvp-999d414c-25 {2}working 0:30$/,
  )
  expect(await ui.find({ type: 'Text', text: /^ {4}━*(▛█▜|▜█▛|███)─* +\d+% {2}0:30$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}Reading parser\.py$/ })).toBeDefined()
  // Its running Explore agent, by its task alone, with a bar of its own; the finished one is gone.
  expect((await ui.find({ type: 'Text', text: /find the parser tests/ }))?.text).toMatch(/^ {3}\S find the parser tests$/)
  expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ {5}━*(▛█▜|▜█▛|███)─* +\d+% {2}0:30 · 2 tools$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /review the fix/ })).toBeUndefined()
  // A resting session with nothing running, and this session itself, are not listed.
  expect(await ui.find({ type: 'Text', text: /999d414c-2a|clawd-at-work-d5/ })).toBeUndefined()
  // Agents no longer says "none yet": only Skills does.
  expect(await ui.findAll({ type: 'Text', text: /^ none yet$/ })).toHaveLength(1)
  await ui.unmount()

  // The token files beside the records are never opened.
  expect(reads.some(p => p.endsWith('.key'))).toBe(false)
})

test('a session waiting for the person flashes', async ($, on) => {
  const clock = engine(on, computer())
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  // The pane keeps animating while this session rests, and the heading flashes.
  const looks = new Set<string>()
  for (let ms = 31_250; ms <= 33_000; ms += 250) {
    await clock.set(ms)
    const ui = await $.ui.mount(pane(60, 80))
    looks.add((await ui.find({ type: 'Text', text: /999d414c-0e/ }))?.text ?? '')
    await ui.unmount()
  }
  expect([...looks].some(t => t.startsWith(' ! '))).toBe(true)
  expect([...looks].some(t => t.startsWith('   '))).toBe(true)
})

test('in a narrow, short pane every other-session line fits 40 columns', async ($, on) => {
  const clock = engine(on, computer())
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  for (const rows of [20, 80]) {
    const ui = await $.ui.mount(pane(40, rows))
    const texts = await ui.findAll({ type: 'Text' })
    for (const t of texts) expect([...(t.text ?? '')].length).toBeLessThanOrEqual(40)
    // Names that share a long prefix keep their distinct end, cut from the front when needed.
    expect(await ui.find({ type: 'Text', text: /^ [! ] \S*-0e {2}needs you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ \S \S*-25 {2}working/ })).toBeDefined()
    await ui.unmount()
  }
})

test("with little room, other sessions still show their bars, a session's under its name", async ($, on) => {
  const clock = engine(on, computer())
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  for (const columns of [40, 60]) {
    // 20 rows: Usage and the rest leave Agents too little for two lines each.
    const ui = await $.ui.mount(pane(columns, 20))
    const bar = /━*(▛█▜|▜█▛|███)─*/
    expect((await ui.find({ type: 'Text', text: /find the/ }))?.text).toMatch(
      new RegExp(`^ {3}\\S ${bar.source} +\\d+% {2}0:30 {2}find the`),
    )
    // A working session's name on its own line, its bar beneath.
    expect((await ui.find({ type: 'Text', text: /-25 {2}working/ }))?.text).toMatch(/^ \S \S*-25 {2}working 0:30$/)
    expect(await ui.find({ type: 'Text', text: new RegExp(`^ {4}${bar.source} +\\d+% {2}0:30$`) })).toBeDefined()
    await ui.unmount()
  }
})

test('a long session name is cut from the front, keeping the end that tells it apart', async ($, on) => {
  const files = computer()
  files[`${HOME}/sessions/222.json`]!.text = JSON.stringify({
    sessionId: 'p2',
    cwd: '/work/genome',
    name: 'genome-m6-mvp-999d414c-and-a-much-longer-tail-0e',
    status: 'waiting',
    waitingFor: 'approve Bash',
    statusUpdatedAt: 1_000,
  })
  const clock = engine(on, files)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  const ui = await $.ui.mount(pane(40, 80))
  const row = (await ui.find({ type: 'Text', text: /tail-0e/ }))?.text ?? ''
  await ui.unmount()
  expect(row).toMatch(/^ [! ] …\S*tail-0e {2}needs you$/)
  expect([...row].length).toBeLessThanOrEqual(40)
})

test('a session in this project shown under Agents is not listed again under Sessions', async ($, on) => {
  const files = computer()
  // p1 also runs this mod in the same project, so it publishes itself in the store.
  files[`${HOME}/sessions/111.json`]!.text = JSON.stringify({
    sessionId: 'p1',
    cwd: '/home/me/repo',
    name: 'repo-a1',
    status: 'busy',
    statusUpdatedAt: 1_000,
  })
  const peer = (id: string, task: string) => ({
    id,
    cwd: '/home/me/repo',
    task,
    state: 'working',
    activity: 'Running npm test',
    percent: 40,
    updatedAt: 30_000,
  })
  const clock = engine(on, files, [], {
    'session:p1': peer('p1', 'the shared one'),
    'session:p9': peer('p9', 'only a peer'),
  })
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  const ui = await $.ui.mount(pane(60, 80))
  // p1 is drawn under Agents by its name, and not under Sessions by its task.
  expect(await ui.findAll({ type: 'Text', text: /^ \S repo-a1 {2}working/ })).toHaveLength(1)
  expect(await ui.find({ type: 'Text', text: /the shared one/ })).toBeUndefined()
  // A peer with no record of its own stays under Sessions.
  expect(await ui.find({ type: 'Text', text: /only a peer/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent that hands back leaves the list', async ($, on) => {
  const files = computer()
  const clock = engine(on, files)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  const log = files[`${PROJECT}/p1/subagents/agent-a9.jsonl`]!
  log.text += call('SubagentHandback', { summary: 'found them' })
  log.mtimeMs = 32_000
  // p1 finished its turn too: nothing of it is left to show.
  files[`${HOME}/sessions/111.json`]!.text = JSON.stringify({
    sessionId: 'p1',
    cwd: '/work/genome',
    name: 'genome-m6-mvp-999d414c-25',
    status: 'idle',
    statusUpdatedAt: 32_000,
  })
  await settle(clock, 36_000, 31_250)

  const ui = await $.ui.mount(pane(60, 80))
  expect(await ui.find({ type: 'Text', text: /find the parser|999d414c-25/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /999d414c-0e/ })).toBeDefined()
  await ui.unmount()
})

test('every subagent shown has its own color, and keeps it when another starts', async ($, on) => {
  const files = computer()
  const agent = (id: string, task: string, mtimeMs: number) => {
    files[`${PROJECT}/p1/subagents/agent-${id}.jsonl`] = { text: call('Grep', { pattern: task }), mtimeMs }
    files[`${PROJECT}/p1/subagents/agent-${id}.meta.json`] = {
      text: JSON.stringify({ agentType: 'general-purpose', description: task }),
      mtimeMs: 1_000,
    }
  }
  for (const id of ['b1', 'b2', 'b3']) agent(id, `task ${id}`, 25_000)
  const clock = engine(on, files)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  // The spinner beside each agent's type is drawn in that agent's color.
  const colors = async () => {
    const ui = await $.ui.mount(pane(60, 80))
    const marks = (await ui.findAll({ type: 'Text', text: /^\S $/ })).map(t => String(t.props.color))
    await ui.unmount()
    return marks
  }
  const first = await colors()
  expect(first).toHaveLength(4)
  expect(new Set(first).size).toBe(4)
  // None is orange, the Claude bar's color.
  expect(first.some(c => /^#FF[5-8][0-9A-F]1[0-9A-F]$/i.test(c))).toBe(false)

  agent('b4', 'task b4', 32_000)
  await settle(clock, 36_000, 31_250)
  const second = await colors()
  expect(second).toHaveLength(5)
  expect(new Set(second).size).toBe(5)
  // The four already shown keep theirs.
  expect(first.every(c => second.includes(c))).toBe(true)

  // The working session has a color of its own too, unlike its agents', and
  // nothing of the other sessions is orange, this session's Claude bar color.
  const ui = await $.ui.mount(pane(60, 80))
  const sessionColor = String((await ui.find({ type: 'Text', text: /^working 0:3\d$/ }))?.props.color)
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  expect(sessionColor).toMatch(/^#/)
  expect(second).not.toContain(sessionColor)
  expect(texts.filter(t => String(t.props.color) === '#FF6B1A' && t.text.trim() !== '').map(t => t.text)).toEqual([])
})

test('with no session records to read, the pane says so under Agents', async ($, on) => {
  const clock = engine(on, {})
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 4_000)

  const ui = await $.ui.mount(pane(40, 40))
  expect((await ui.find({ type: 'Text', text: /other sessions:/ }))?.text).toMatch(/^ other sessions: can't read /)
  await ui.unmount()
})
