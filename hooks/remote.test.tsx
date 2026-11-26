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
  engineFiles(on, files, reads)
  return clock
}

// The engine but for its clock and store: the session, `files` as its disk,
// and `agents` as what `$.agent.list()` reports.
const engineFiles = (on: On, files: Record<string, File>, reads: string[] = [], agents: unknown[] = []) => {
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } as never }))
  on('session.id', () => ({ value: 'me' }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('session.info', () => ({ value: { transcriptPath: `${HOME}/projects/-home-me-repo/me.jsonl` } }) as never)
  on('agent.list', () => ({ value: agents }) as never)
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
  // Its running Explore agent, by its task alone, with a bar of its own.
  expect((await ui.find({ type: 'Text', text: /find the parser tests/ }))?.text).toMatch(/^ {3}[◐◓◑◒] find the parser tests$/)
  expect(await ui.find({ type: 'Text', text: /Explore/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ {5}━*(▛█▜|▜█▛|███)─* +\d+% {2}0:30 · 2 tools$/ })).toBeDefined()
  // The finished one stays a while, marked done, with a full bar and its run time.
  expect((await ui.find({ type: 'Text', text: /review the fix/ }))?.text).toMatch(/^ {3}✓ review the fix$/)
  expect(await ui.find({ type: 'Text', text: /^ {5}━+\S+ 100% {2}0:19 · 1 tool$/ })).toBeDefined()
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
    // A working session's name on its own line, its bar beneath; its finished
    // agent gives its row up to a count.
    expect((await ui.find({ type: 'Text', text: /-25 {2}working/ }))?.text).toMatch(/^ \S \S*-25 {2}working 0:30 · 1 done$/)
    expect(await ui.find({ type: 'Text', text: /review the fix/ })).toBeUndefined()
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

test('a subagent that hands back shows as done, its session idle', async ($, on) => {
  const files = computer()
  const clock = engine(on, files)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  const log = files[`${PROJECT}/p1/subagents/agent-a9.jsonl`]!
  log.text += call('SubagentHandback', { summary: 'found them' })
  log.mtimeMs = 32_000
  // p1 finished its turn too: it rests, showing which of its agents finished.
  files[`${HOME}/sessions/111.json`]!.text = JSON.stringify({
    sessionId: 'p1',
    cwd: '/work/genome',
    name: 'genome-m6-mvp-999d414c-25',
    status: 'idle',
    statusUpdatedAt: 32_000,
  })
  await settle(clock, 36_000, 31_250)

  const ui = await $.ui.mount(pane(60, 80))
  expect((await ui.find({ type: 'Text', text: /999d414c-25/ }))?.text).toMatch(/^ ○ genome-m6-mvp-999d414c-25 {2}idle$/)
  expect((await ui.find({ type: 'Text', text: /find the parser/ }))?.text).toMatch(/^ {3}✓ find the parser tests$/)
  expect((await ui.find({ type: 'Text', text: /review the fix/ }))?.text).toMatch(/^ {3}✓ review the fix$/)
  // Nothing of it runs: the heading counts no agent in other sessions.
  expect((await ui.find({ type: 'Text', text: /^Agents/ }))?.text).toMatch(/^Agents\s*$/)
  expect(await ui.find({ type: 'Text', text: /999d414c-0e/ })).toBeDefined()
  await ui.unmount()
})

test('a session is shown by its title: the one set with /rename, else the one Claude gave it', async ($, on) => {
  const files = computer()
  const title = (type: string, key: string, value: string) => line({ type, [key]: value, sessionId: 'p1' })
  files[`${PROJECT}/p1.jsonl`]!.text += title('ai-title', 'aiTitle', 'Ticket 5 branch')
  const clock = engine(on, files)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  let ui = await $.ui.mount(pane(40, 80))
  expect((await ui.find({ type: 'Text', text: /Ticket 5/ }))?.text).toMatch(/^ \S Ticket 5 branch {2}working 0:30$/)
  expect(await ui.find({ type: 'Text', text: /999d414c-25/ })).toBeUndefined()
  await ui.unmount()

  // Renamed: that name wins, and a long one is cut at its end.
  const file = files[`${PROJECT}/p1.jsonl`]!
  file.text += title('custom-title', 'customTitle', 'Parser rewrite for the genome importer')
  file.mtimeMs = 32_000
  await settle(clock, 36_000, 31_250)
  ui = await $.ui.mount(pane(40, 80))
  expect((await ui.find({ type: 'Text', text: /Parser/ }))?.text).toMatch(/^ \S Parser rewrite for th\S*… {2}working 0:3\d$/)
  await ui.unmount()
})

test("an agent is drawn in the color its own session gave it, and a new one here avoids it", async ($, on) => {
  // A store of the test's own, to read what the mod publishes.
  const kept = new Map<string, unknown>([
    // p1 runs this mod too, in another project, and gave its agent a9 slot 0.
    ['session:p1', { id: 'p1', cwd: '/work/genome', task: 'run the suite', state: 'working', activity: '', percent: 10, updatedAt: 30_000, hues: { a9: 0 } }],
  ])
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
  const files = computer()
  // This session's agent x1, listed once it is spawned.
  const listed: unknown[] = []
  engineFiles(on, files, [], listed)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('agent.spawn', () => ({ agentId: 'x1', model: 'test' }))
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock)

  // a9 is drawn in slot 0, cyan, as its own session drew it.
  let ui = await $.ui.mount(pane(60, 80))
  expect(String((await ui.find({ type: 'Text', text: /^[◐◓◑◒] $/ }))?.props.color)).toBe('#00C8FF')
  await ui.unmount()

  // An agent started here skips cyan, which a9 holds, and is published in its
  // own color for the other panes.
  await $.turn.start({ text: 'look', turnId: 't1' })
  await $.agent.spawn({
    tool_use_id: 'tu1',
    prompt: 'look',
    description: 'find code',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'user' },
    parentModel: 'test',
    background: true,
    fork: false,
  } as never)
  listed.push({ id: 'x1', description: 'find code', type: 'Explore', status: 'running' })
  await settle(clock, 36_000, 31_250)
  ui = await $.ui.mount(pane(60, 80))
  const mine = await ui.find({ type: 'Button', text: /Explore/ })
  await ui.unmount()
  expect(mine).toBeDefined()
  const published = (kept.get('session:me') as { hues?: Record<string, number> } | undefined)?.hues
  expect(published?.tu1).toBe(1)
  expect(published?.x1).toBe(1)
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

  // The spinner beside each running agent is drawn in that agent's color.
  const colors = async () => {
    const ui = await $.ui.mount(pane(60, 80))
    const marks = (await ui.findAll({ type: 'Text', text: /^[◐◓◑◒] $/ })).map(t => String(t.props.color))
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

  // The working session is drawn in a muted color, unlike any agent, and
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
