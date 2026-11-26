import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// R8: each session's own color (its Claude bar here, its line in the other
// panes), and the sounds that call the person back.

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
const ORANGE = '#FF6B1A'
const BLUE = '#3D6BFF'
const GREEN = '#00E676'
const PURPLE = '#9B4DFF'
const SESSION_HEXES = ['#FF6B1A', '#3D6BFF', '#00E676', '#FF2E9A', '#00C8FF', '#9B4DFF', '#FFD400', '#FF3B3B', '#1DE9B6', '#C6FF00']

type File = { text: string; mtimeMs: number }
const record = (value: Record<string, unknown>): File => ({ text: JSON.stringify(value), mtimeMs: 1_000 })

// p1 works (and runs this mod when a test publishes it), p2 runs without the
// mod and works too; `444.json` is this session's own record.
const computer = (): Record<string, File> => ({
  [`${HOME}/sessions/111.json`]: record({ sessionId: 'p1', cwd: '/work/genome', name: 'alpha-session', status: 'busy', statusUpdatedAt: 1_000 }),
  [`${HOME}/sessions/222.json`]: record({ sessionId: 'p2', cwd: '/work/genome', name: 'beta-session', status: 'busy', statusUpdatedAt: 1_000 }),
  [`${HOME}/sessions/444.json`]: record({ sessionId: 'me', cwd: '/home/me/repo', name: 'mine', status: 'busy', statusUpdatedAt: 1_000 }),
  [`${PROJECT}/p1.jsonl`]: { text: '', mtimeMs: 20_000 },
  [`${PROJECT}/p2.jsonl`]: { text: '', mtimeMs: 20_000 },
})

const disk = (path: string) => path.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')

// The engine beneath the mod: `files` as the disk, `kept` as the store shared
// by every session, a Windows machine, and each command it runs noted in `played`.
const engine = (on: On, files: Record<string, File>, kept: Map<string, unknown>, played: string[][], ran = { exitCode: 0, stderr: '' }) => {
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
  on('command.register', () => ({ value: { command: 'clawd-at-work' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } as never }))
  on('session.id', () => ({ value: 'me' }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('session.info', () => ({ value: { transcriptPath: `${HOME}/projects/-home-me-repo/me.jsonl` } }) as never)
  on('session.machine', () => ({ value: { sysname: 'Windows_NT', release: '10.0', machine: 'x86_64', packageManagers: [], runtimes: [] } }) as never)
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_ROOT: 'C:\\mods\\clawd-at-work' } }) as never)
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    played.push([...e.argv])
    return { value: { exitCode: ran.exitCode, stdout: '', stderr: ran.stderr } } as never
  })
  on('agent.list', () => ({ value: [] }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', () => ({ result: {} }))
  on('fs.list', (_, e) => {
    const prefix = `${disk(e.path)}/`
    const names = Object.keys(files).filter(p => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    if (names.length === 0 && !Object.keys(files).some(p => p.startsWith(prefix))) throw new Error('ENOENT')
    return {
      value: names.map(p => ({ name: p.slice(prefix.length), kind: 'file' as const, size: files[p]!.text.length, mtimeMs: files[p]!.mtimeMs, isLink: false })),
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
    const offset = e.offset ?? 0
    return { value: file.text.slice(offset, e.length === undefined ? undefined : offset + e.length) }
  })
  return clock
}

const settle = async (clock: { set: (ms: number) => Promise<unknown> }, until: number, from: number) => {
  for (let ms = from; ms <= until; ms += 250) await clock.set(ms)
}

// A peer record of a session running this mod, as it publishes it.
const peer = (id: string, color: string, updatedAt = 30_000) => ({
  id,
  cwd: '/work/genome',
  task: 'run the suite',
  state: 'working',
  activity: '',
  percent: 10,
  updatedAt,
  hues: {},
  color,
})

const sounds = (played: string[][]) => played.map(argv => /sounds\\(\w+)\.wav/.exec(argv.join(' '))?.[1])

test('R8.1: a session takes the first color no other session has, and publishes it', async ($, on) => {
  const kept = new Map<string, unknown>([['session:p1', peer('p1', 'orange', 1_000)]])
  const clock = engine(on, computer(), kept, [])
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 6_000, 1_250)
  expect((kept.get('session:me') as { color?: string }).color).toBe('blue')

  // Its Claude bar and activity line are drawn in it.
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(pane(60, 60))
  expect(String((await ui.find({ type: 'Text', text: /^thinking…$/ }))?.props.color)).toBe(BLUE)
  await ui.unmount()
})

test('R8.2: /clawd-at-work color <name> sets the color, which the bar and the published status follow', async ($, on) => {
  const kept = new Map<string, unknown>()
  const clock = engine(on, computer(), kept, [])
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 3_000, 1_250)
  expect((kept.get('session:me') as { color?: string }).color).toBe('orange')

  const out = await $.command.run({ command: 'clawd-at-work', args: 'color purple' } as never)
  expect(out.text).toMatch(/now purple/)
  await settle(clock, 8_000, 3_250)
  expect((kept.get('session:me') as { color?: string }).color).toBe('purple')
  await $.turn.start({ text: 'go', turnId: 't1' })
  const ui = await $.ui.mount(pane(60, 60))
  expect(String((await ui.find({ type: 'Text', text: /^thinking…$/ }))?.props.color)).toBe(PURPLE)
  await ui.unmount()

  // An unknown name changes nothing and lists the choices.
  expect((await $.command.run({ command: 'clawd-at-work', args: 'color mauve' } as never)).text).toMatch(/No color named "mauve".*orange, blue/)
  // A chosen color stays even when another session publishes the same one.
  kept.set('session:a0', peer('a0', 'purple', 9_000))
  await settle(clock, 12_000, 8_250)
  expect((kept.get('session:me') as { color?: string }).color).toBe('purple')
})

test('R8.3: another session is drawn in its own vivid color: the published one, else one picked here', async ($, on) => {
  const kept = new Map<string, unknown>([['session:p1', peer('p1', 'green')]])
  const clock = engine(on, computer(), kept, [])
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 31_000, 1_250)

  const ui = await $.ui.mount(pane(60, 80))
  // p1 runs this mod and chose green: its name and bar are green.
  expect(String((await ui.find({ type: 'Text', text: /^ alpha-session$/ }))?.props.color)).toBe(GREEN)
  // p2 runs without it: a session color no one else here has, never grey.
  const p2 = String((await ui.find({ type: 'Text', text: /^ beta-session$/ }))?.props.color)
  expect(SESSION_HEXES).toContain(p2)
  expect([GREEN, ORANGE]).not.toContain(p2)
  await ui.unmount()
})

test('R8.4: a sound plays when this session starts to wait for the person, not for what already waited', async ($, on) => {
  const files = computer()
  // p2 already waits when the pane first looks: no sound for it.
  files[`${HOME}/sessions/222.json`] = record({ sessionId: 'p2', cwd: '/work/genome', name: 'beta-session', status: 'waiting', waitingFor: 'approve Bash', statusUpdatedAt: 1_000 })
  const played: string[][] = []
  const clock = engine(on, files, new Map(), played)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 6_000, 1_250)
  expect(played).toHaveLength(0)

  // This session's own record says a permission prompt opened: one sound,
  // played by PowerShell from the mod's own folder.
  files[`${HOME}/sessions/444.json`] = record({ sessionId: 'me', cwd: '/home/me/repo', name: 'mine', status: 'waiting', waitingFor: 'approve Bash', statusUpdatedAt: 6_000 })
  await settle(clock, 12_000, 6_250)
  expect(sounds(played)).toEqual(['attention'])
  expect(played[0]![0]).toBe('powershell')
  expect(played[0]!.join(' ')).toContain('C:\\mods\\clawd-at-work\\sounds\\attention.wav')

  // Another session without the mod starts to wait: this pane, the only one
  // publishing, sounds for it.
  files[`${HOME}/sessions/111.json`] = record({ sessionId: 'p1', cwd: '/work/genome', name: 'alpha-session', status: 'waiting', waitingFor: 'your answer', statusUpdatedAt: 12_000 })
  await settle(clock, 16_000, 12_250)
  expect(sounds(played)).toEqual(['attention', 'attention'])
})

test('R8.5: a question sounds at once, a finished turn plays the done sound, and sound off silences both', async ($, on) => {
  const played: string[][] = []
  const kept = new Map<string, unknown>()
  const clock = engine(on, computer(), kept, played)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 3_000, 1_250)

  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await settle(clock, 4_000, 3_250)
  expect(sounds(played)).toEqual(['attention'])

  // A long turn ends: done. A quick or stopped one does not sound.
  await $.turn.complete({ answer: '', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(clock, 5_000, 4_250)
  expect(sounds(played)).toEqual(['attention', 'done'])
  await $.turn.start({ text: 'go', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't2', reason: 'answer' })
  await $.turn.start({ text: 'go', turnId: 't3' })
  await $.turn.complete({ answer: '', durationMs: 30_000, isAborted: true, turnId: 't3', reason: 'interrupted' } as never)
  await settle(clock, 20_000, 5_250)
  expect(sounds(played)).toEqual(['attention', 'done'])

  // Off, for every session: kept in the store.
  expect((await $.command.run({ command: 'clawd-at-work', args: 'sound off' } as never)).text).toMatch(/off/)
  expect(kept.get('sound-on')).toBe(false)
  await $.turn.start({ text: 'go', turnId: 't4' })
  await $.turn.complete({ answer: '', durationMs: 30_000, isAborted: false, turnId: 't4', reason: 'answer' })
  await settle(clock, 22_000, 20_250)
  expect(sounds(played)).toEqual(['attention', 'done'])
})

test("R8.6: an agent never takes its own session's color", async ($, on) => {
  const kept = new Map<string, unknown>()
  const clock = engine(on, computer(), kept, [])
  on('agent.spawn', () => ({ agentId: 'x1', model: 'test' }))
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  // Cyan is agent slot 0, where the first agent would start.
  await $.command.run({ command: 'clawd-at-work', args: 'color cyan' } as never)
  await $.turn.start({ text: 'go', turnId: 't1' })
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
  await settle(clock, 4_000, 1_250)
  const hues = (kept.get('session:me') as { hues?: Record<string, number> }).hues
  expect(hues?.tu1).toBe(1)
})

test('R8.5: sound off set in another session silences this one too', async ($, on) => {
  const played: string[][] = []
  const kept = new Map<string, unknown>()
  const clock = engine(on, computer(), kept, played)
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 3_000, 1_250)
  // Another session wrote the shared setting after this one started.
  kept.set('sound-on', false)
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 30_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle(clock, 5_000, 3_250)
  expect(played).toHaveLength(0)
})

test('R8.5: sound test says why it could not play', async ($, on) => {
  const played: string[][] = []
  const clock = engine(on, computer(), new Map(), played, { exitCode: 1, stderr: 'no audio device' })
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 2_000, 1_250)
  const out = await $.command.run({ command: 'clawd-at-work', args: 'sound test' } as never)
  expect(out.text).toMatch(/^No sound: could not play .*attention\.wav \(powershell exited 1: no audio device\)$/)
})

test('R8.1: an automatic color moves off one another session picked', async ($, on) => {
  const kept = new Map<string, unknown>()
  const clock = engine(on, computer(), kept, [])
  await $.session.start({ cwd: '/home/me/repo', surface: 'terminal', isInteractive: true })
  await settle(clock, 3_000, 1_250)
  expect((kept.get('session:me') as { color?: string }).color).toBe('orange')
  // A session whose id sorts after this one picks orange by hand.
  kept.set('session:zz', { ...peer('zz', 'orange', 3_000), colorPicked: true })
  await settle(clock, 9_000, 3_250)
  expect((kept.get('session:me') as { color?: string }).color).toBe('blue')
})
