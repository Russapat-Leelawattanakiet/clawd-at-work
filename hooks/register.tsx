import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface, ModelUsage, Register, SessionCost } from 'claude-code'

import type {
  Call,
  FeedItem,
  Limit,
  MainTurn,
  Mood,
  PlanStep,
  Run,
  TouchedFile,
  TurnSummary,
  Typical,
  Usage,
  WeekTokens,
} from '../types'

const PANE = 'clawd-at-work'
const TITLE = 'Claude at work'
// Ticker period: ~4 fps keeps the mascot lively without flooding redraws.
const TICK_MS = 250
// Poll `$.agent.list()` every Nth tick (~1 s) while agents are running, and
// every Mth (~2 s) otherwise, for agents that start with no agent.spawn.
const POLL_EVERY = 4
const DISCOVER_EVERY = 8
const MAX_RUNS = 100
const ORANGE = 'claude'
// One color per agent, handed out in spawn order so parallel agents differ.
// Fully saturated so each bar pops: orange, cyan, violet, green, yellow, pink.
const PALETTE = ['#FF5A1F', '#00C8FF', '#9B4DFF', '#00E676', '#FFD400', '#FF2E9A']
// The Claude bar and plan steps: a hot Claude orange in the same saturation.
const HOT = '#FF6B1A'
// Tiny mini Clawd riding the bar, 3 characters: just its face, with the real
// Clawd eyes (the notches of ▛█▜). The eyes glance left and right as it runs
// and it blinks now and then; eyes shut once done, crossed out if it failed.
const RUNNER = ['▛█▜', '▜█▛']
const RUNNER_BLINK = '███'
const RUNNER_DONE = '▀█▀'
const RUNNER_FAILED = '×█×'
// Blink on one frame in BLINK_EVERY (~4 s at 4 fps), never on frame 0.
const BLINK_EVERY = 17
// Tool calls kept per agent, and how many an open dropdown shows.
const MAX_CALLS = 30
const SHOWN_CALLS = 8
// Input fields that name what a tool call works on, in order of preference.
const TARGET_FIELDS = ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'skill', 'description', 'prompt']
const TARGET_MAX = 40

// The plan tool Claude calls to declare its steps; the model sees it as
// mcp__<plugin>__plan. A short system-prompt note asks Claude to use it.
const PLAN_TOOL = 'plan'
const PLAN_TOOL_FULL = 'mcp__clawd-at-work__plan'
const MAX_STEPS = 20
const STEP_MAX = 60
const SHOWN_STEPS = 8
const PLAN_NOTE = [
  'The person watches a "Claude at work" pane that shows your progress as a bar.',
  `For any task with two or more steps, call the ${PLAN_TOOL_FULL} tool before starting,`,
  'listing every step you intend to take as a short title (status "pending", the first one "active").',
  'Call it again with the whole list each time a step starts or finishes, so the bar stays true.',
  'Mark every step "done" before your final answer. Skip the tool for one-step replies.',
].join(' ')

// Progress estimate: elapsed / typical run time of that agent type, held
// below 100% until the agent really ends. First runs use these defaults.
const STORE_KEY = 'agent-typical'
// The main loop's own turns are learned under this key, beside agent types.
const MAIN_KEY = '__main__'
// Plan steps are learned under this one, all steps alike; auto steps under
// one per kind, since a tool call is much quicker than a stretch of thinking.
const STEP_KEY = '__step__'
const TOOL_KEY = '__tool__'
const THINK_KEY = '__think__'
const DEFAULT_MS: Record<string, number> = {
  Explore: 45_000,
  [MAIN_KEY]: 60_000,
  [STEP_KEY]: 30_000,
  [TOOL_KEY]: 5_000,
  [THINK_KEY]: 10_000,
}
const FALLBACK_MS = 90_000
const MAX_ESTIMATE = 95
// Recent runs weigh more: the running mean counts at most this many.
const LEARN_WINDOW = 10

// Usage: the account's rate-limit windows as the engine reports them, in the
// order shown and under these names, and the tokens counted this week.
const LIMIT_NAMES: Record<string, string> = { five_hour: 'Session', seven_day: 'Week', spend_limit: 'Spend' }
const LIMIT_ORDER = ['five_hour', 'seven_day', 'spend_limit']
const WEEK_KIND = 'seven_day'
const WEEK_KEY = 'week-tokens'
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
// Bars turn yellow, then red, as a window fills.
const WARN_AT = 70
const ALERT_AT = 90
// While idle, redraw once a minute (every Nth tick) so reset times count down.
const IDLE_REDRAW = 240

// Recent: the main loop's tool calls kept, and how many show under a plan.
const MAX_FEED = 20
const FEED_SHOWN = 4
// Files: how many are kept since the last prompt.
const MAX_FILES = 40
// Clawd shows a failed call for this long, and cheers this long once a turn ends.
const FAIL_MS = 3_000
const CHEER_MS = 4_000

// Change the shape tag when Run's fields change incompatibly: values stored
// by an earlier version are then read as the initial value instead.
const runs = atom({ plugin: 'clawd-at-work', key: 'runs' } as const, [], {
  shape: 'runs-1',
})
const busySince = atom({ plugin: 'clawd-at-work', key: 'busySince' } as const, null)
const frame = atom({ plugin: 'clawd-at-work', key: 'frame' } as const, 0)
const typical = atom({ plugin: 'clawd-at-work', key: 'typical' } as const, {})
const expanded = atom({ plugin: 'clawd-at-work', key: 'expanded' } as const, [])
const IDLE_MAIN: MainTurn = { activity: '', steps: 0, tools: 0 }
const main = atom({ plugin: 'clawd-at-work', key: 'main' } as const, IDLE_MAIN)
const plan = atom({ plugin: 'clawd-at-work', key: 'plan' } as const, [])
const autoSteps = atom({ plugin: 'clawd-at-work', key: 'autoSteps' } as const, [])
const NO_USAGE: Usage = { limits: [], sessionTokens: 0, weekTokens: 0 }
const usage = atom({ plugin: 'clawd-at-work', key: 'usage' } as const, NO_USAGE)
const feed = atom({ plugin: 'clawd-at-work', key: 'feed' } as const, [])
const feedCount = atom({ plugin: 'clawd-at-work', key: 'feedCount' } as const, 0)
const files = atom({ plugin: 'clawd-at-work', key: 'files' } as const, [])
const summary = atom({ plugin: 'clawd-at-work', key: 'summary' } as const, null)

// ---------------------------------------------------------------- helpers

// Patch every run that matches `pick`.
const patch = ($: EngineInterface, pick: (r: Run) => boolean, change: Partial<Run>) =>
  update($, runs, list => list.map(r => (pick(r) ? { ...r, ...change } : r)))

const add = ($: EngineInterface, run: Run) =>
  update($, runs, list => [...list, run].slice(-MAX_RUNS))

// Map the engine's agent status onto the pane's three states.
const toStatus = (s: AgentStatus): Run['status'] =>
  s === 'completed' || s === 'idle'
    ? 'done'
    : s === 'failed' || s === 'killed'
      ? 'failed'
      : 'running'

// m:ss, or h:mm:ss past an hour.
const clock = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

// A short duration for tool lines: 0.4s under ten seconds, else m:ss.
const short = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : clock(ms))

// `text` cut to at most `width` characters, ending in … when cut.
const clip = (text: string, width: number) => (text.length > width ? `${text.slice(0, width - 1)}…` : text)

// A path's file name alone.
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

// One spelling per file: forward slashes, and a Windows drive path (C:\...)
// in lower case, since Windows paths ignore case.
const pathKey = (path: string) => {
  const slashed = path.replace(/\\/g, '/')
  return /^[A-Za-z]:\//.test(slashed) ? slashed.toLowerCase() : slashed
}

// "1 tool", "2 tools".
const plural = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`

// A leading change of folder (`cd repo && npm test`, `Set-Location x; ...`)
// says nothing of the work and fills the line, so it is dropped. A command
// that only changes folder keeps the folder's name.
const CD_PREFIX = /^\s*(?:cd|chdir|pushd|set-location|sl)\b(?:"[^"]*"|'[^']*'|[^"'&;|\n])*(?:&&|;|\n)\s*/i
const CD_ONLY = /^\s*(?:cd|chdir|pushd|set-location|sl)\s+(?:\/d\s+)?["']?(.*?)["']?\s*$/i
const shellTarget = (command: string) => {
  let rest = command
  for (let m = CD_PREFIX.exec(rest); m && m[0].length < rest.length; m = CD_PREFIX.exec(rest)) {
    rest = rest.slice(m[0].length)
  }
  const only = CD_ONLY.exec(rest)
  return only ? `cd ${baseName(only[1]!.replace(/[\\/]+$/, ''))}` : rest
}

// What a tool call works on: the first naming field of its input, with a
// path cut to its file name and one line of at most TARGET_MAX characters.
const targetOf = (input: Record<string, unknown>) => {
  for (const field of TARGET_FIELDS) {
    const value = input[field]
    if (typeof value !== 'string' || value === '') continue
    const text = field.endsWith('path') ? baseName(value) : field === 'command' ? shellTarget(value) : value
    return clip(text.split('\n')[0] ?? '', TARGET_MAX)
  }
  return ''
}

// A tool's display name: MCP tools read as `server tool`, not mcp__server__tool.
const toolName = (name: string) =>
  name.startsWith('mcp__') ? name.split('__').slice(1).join(' ') : name

// Steps from a plan or TodoWrite call: titles trimmed to one short line,
// unknown statuses read as pending, at most MAX_STEPS kept.
const toSteps = (raw: unknown, title: string, status: (s: unknown) => PlanStep['status']): PlanStep[] =>
  (Array.isArray(raw) ? raw : []).slice(0, MAX_STEPS).flatMap(item => {
    const step = item as Record<string, unknown> | null
    const text = typeof step?.[title] === 'string' ? (step[title] as string).split('\n')[0]!.trim() : ''
    if (text === '') return []
    return [{ title: clip(text, STEP_MAX), status: status(step?.status) }]
  })

// Which learned typical time a step's bar is timed against.
const stepKeyOf = (s: PlanStep) => (s.kind === 'tool' ? TOOL_KEY : s.kind === 'think' ? THINK_KEY : STEP_KEY)

// One step's percent: done 100, pending 0, active its time so far over the
// learned typical time for its kind, held below 100% until it is done.
const stepPercent = (s: PlanStep, t: Typical, now: number) =>
  s.status === 'done'
    ? 100
    : s.status === 'pending'
      ? 0
      : Math.min(MAX_ESTIMATE, Math.floor(((now - (s.startedAt ?? now)) / typicalMs(t, stepKeyOf(s))) * 100))

// Percent of a whole plan: the mean of its steps' percents.
const planPercent = (steps: PlanStep[], t: Typical, now: number) =>
  steps.length === 0 ? 0 : Math.round(steps.reduce((sum, s) => sum + stepPercent(s, t, now), 0) / steps.length)

// Store a new plan, keeping each step's times from the last one (matched by
// title): a step is timed from when it first left pending until it was done.
// An active step that is now done teaches the typical step time.
const applyPlan = async ($: EngineInterface, steps: PlanStep[]) => {
  const now = await $.clock.now()
  const before = new Map((await read($, plan)).map(s => [s.title, s]))
  const finished: number[] = []
  const timed = steps.map(s => {
    const old = before.get(s.title)
    if (s.status === 'pending') return { title: s.title, status: s.status }
    if (s.status === 'done' && old?.status === 'active' && old.startedAt !== undefined) {
      finished.push(now - old.startedAt)
    }
    const startedAt = old?.startedAt ?? now
    return { ...s, startedAt, endedAt: s.status === 'done' ? (old?.endedAt ?? now) : undefined }
  })
  await update($, plan, () => timed)
  for (const ms of finished) await learn($, STEP_KEY, ms).catch(() => {})
}

// Plain words for each tool: `action` titles an auto step and a feed row,
// `doing` is the line under the Claude bar as it happens, and `mood` is the
// kind of work (Clawd's prop, the word beside Clawd and the feed's icon).
// Asking means Claude waits on the person.
const TOOLS: Record<string, { action: string; doing: string; mood: Mood }> = {
  Read: { action: 'Read', doing: 'Reading', mood: 'read' },
  Edit: { action: 'Edit', doing: 'Editing', mood: 'edit' },
  Write: { action: 'Write', doing: 'Writing', mood: 'edit' },
  NotebookEdit: { action: 'Edit notebook', doing: 'Editing notebook', mood: 'edit' },
  Bash: { action: 'Run', doing: 'Running', mood: 'run' },
  PowerShell: { action: 'Run', doing: 'Running', mood: 'run' },
  Grep: { action: 'Search', doing: 'Searching for', mood: 'search' },
  Glob: { action: 'Find files', doing: 'Finding files', mood: 'search' },
  WebSearch: { action: 'Search the web', doing: 'Searching the web for', mood: 'web' },
  WebFetch: { action: 'Fetch', doing: 'Fetching', mood: 'web' },
  Agent: { action: 'Start agent', doing: 'Running agent', mood: 'agent' },
  Skill: { action: 'Load skill', doing: 'Loading skill', mood: 'read' },
  AskUserQuestion: { action: 'Ask you a question', doing: 'Asking you', mood: 'ask' },
  ExitPlanMode: { action: 'Ask you to approve the plan', doing: 'Asking you to approve the plan', mood: 'ask' },
  Artifact: { action: 'Publish page', doing: 'Publishing page', mood: 'tool' },
  ToolSearch: { action: 'Load tools', doing: 'Loading tools', mood: 'search' },
  TodoWrite: { action: 'Update the plan', doing: 'Updating the plan', mood: 'think' },
  [PLAN_TOOL_FULL]: { action: 'Update the plan', doing: 'Updating the plan', mood: 'think' },
}
const withTarget = (words: string, target: string) => `${words}${target ? ` ${target}` : ''}`
const actionTitle = (tool: string, target: string) => withTarget(TOOLS[tool]?.action ?? toolName(tool), target)
const doingTitle = (tool: string, target: string) => withTarget(TOOLS[tool]?.doing ?? toolName(tool), target)
const moodOf = (tool: string): Mood => TOOLS[tool]?.mood ?? 'tool'

// The feed keeps its newest MAX_FEED calls and counts every one pushed.
const pushFeed = async ($: EngineInterface, item: FeedItem) => {
  await update($, feed, list => [...list, item].slice(-MAX_FEED))
  await update($, feedCount, k => k + 1)
}

const patchFeed = ($: EngineInterface, id: string, change: Partial<FeedItem>) =>
  update($, feed, list => list.map(f => (f.id === id ? { ...f, ...change } : f)))

// The file tools, and whether each edits. Reads are listed from the main loop
// only (an agent reads too much to be useful); edits from any loop.
const FILE_TOOLS: Record<string, boolean> = { Read: false, Edit: true, Write: true, NotebookEdit: true }
const touch = ($: EngineInterface, tool: string, input: Record<string, unknown>, isMain: boolean) => {
  const isEdit = FILE_TOOLS[tool]
  if (isEdit === undefined || (!isEdit && !isMain)) return Promise.resolve()
  const path = [input.file_path, input.notebook_path].find(v => typeof v === 'string' && v !== '') as string | undefined
  if (path === undefined) return Promise.resolve()
  const key = pathKey(path)
  return update($, files, list => {
    const old = list.find(f => pathKey(f.path) === key)
    if (old) {
      return old.isEdited || !isEdit ? list : list.map(f => (pathKey(f.path) === key ? { ...f, isEdited: true } : f))
    }
    const file: TouchedFile = { path, name: baseName(path), isEdited: isEdit }
    const grown = [...list, file]
    if (grown.length <= MAX_FILES) return grown
    // Over the cap, the oldest file only read goes first, so edits stay listed.
    const drop = grown.findIndex(f => !f.isEdited)
    return grown.filter((_, i) => i !== (drop === -1 ? 0 : drop))
  })
}

// Finish every active auto step, teaching each kind's typical time.
const finishAuto = async ($: EngineInterface) => {
  const steps = await read($, autoSteps)
  const active = steps.filter(s => s.status === 'active')
  if (active.length === 0) return
  const now = await $.clock.now()
  await update($, autoSteps, list =>
    list.map(s => (s.status === 'active' ? { ...s, status: 'done' as const, endedAt: now } : s)),
  )
  for (const s of active) await learn($, stepKeyOf(s), now - (s.startedAt ?? now)).catch(() => {})
}

// Start an auto step for what the main loop does next, finishing the one
// before. A repeat of the same action merges into the last step, counted.
// While Claude has declared a plan, that plan is shown, so nothing is made.
const startAuto = async ($: EngineInterface, kind: 'tool' | 'think', key: string, title: string) => {
  if ((await read($, plan)).length > 0) return
  await finishAuto($)
  const now = await $.clock.now()
  await update($, autoSteps, list => {
    const last = list.at(-1)
    if (last?.key === key) {
      const merged = { ...last, status: 'active' as const, startedAt: now, endedAt: undefined, count: (last.count ?? 1) + 1 }
      return [...list.slice(0, -1), merged]
    }
    return [...list, { title, status: 'active' as const, kind, key, startedAt: now }].slice(-MAX_STEPS)
  })
}

// Retitle the active auto step (thinking becomes writing the reply).
const retitleAuto = ($: EngineInterface, title: string) =>
  update($, autoSteps, list => list.map(s => (s.status === 'active' && s.kind === 'think' ? { ...s, title } : s)))

const setActivity = ($: EngineInterface, activity: string, mood: Mood) =>
  update($, main, m => (m.activity === activity && m.mood === mood ? m : { ...m, activity, mood }))

// Patch the tool call `callId` of agent `agentId`.
const patchCall = ($: EngineInterface, agentId: string, callId: string, change: Partial<Call>) =>
  update($, runs, list =>
    list.map(r =>
      r.kind === 'agent' && r.agentId === agentId
        ? { ...r, calls: (r.calls ?? []).map(c => (c.id === callId ? { ...c, ...change } : c)) }
        : r,
    ),
  )

// Typical run time for an agent type: learned, else the default. Floored at
// a second so an instant run can never make the estimate divide by zero.
const MIN_TYPICAL_MS = 1_000
const typicalMs = (t: Typical, type: string) =>
  Math.max(MIN_TYPICAL_MS, t[type]?.avgMs ?? DEFAULT_MS[type] ?? FALLBACK_MS)

// Estimated percent done: 100 once finished, else capped below 100.
const percent = (r: Run, t: Typical, now: number) => {
  if (r.status === 'done') return 100
  const elapsed = (r.endedAt ?? now) - r.startedAt
  return Math.min(MAX_ESTIMATE, Math.floor((elapsed / typicalMs(t, r.name)) * 100))
}

// Fold one finished run's duration into the averages, in state and store.
const learn = async ($: EngineInterface, type: string, ms: number) => {
  await update($, typical, t => {
    const old = t[type]
    const n = Math.min((old?.n ?? 0) + 1, LEARN_WINDOW)
    const avgMs = old ? old.avgMs + (ms - old.avgMs) / n : ms
    return { ...t, [type]: { avgMs, n } }
  })
  await $.store.set(STORE_KEY, await read($, typical))
}

// Next palette slot after the newest agent's, so neighbours never match.
const nextHue = (list: readonly Run[]) => {
  const last = list.filter(r => r.kind === 'agent').at(-1)
  return last?.hue === undefined ? 0 : (last.hue + 1) % PALETTE.length
}

// Add a row for each running agent the engine lists that the pane has not
// seen: loops the engine starts with no `agent.spawn` (a forked skill, such as
// a review running in the background) arrive this way. Ones already finished
// are left out, so rows a prompt cleared never come back. While a spawn has not
// answered its agent's id yet, wait: that agent is the row being spawned.
const discoverAgents = async ($: EngineInterface, agents: readonly AgentInfo[], now: number) => {
  const list = await read($, runs)
  if (list.some(r => r.kind === 'agent' && r.status === 'running' && r.agentId === undefined)) return
  const known = new Set(list.flatMap(r => (r.kind === 'agent' && r.agentId ? [r.agentId] : [])))
  const fresh = agents.filter(a => !known.has(a.id) && toStatus(a.status) === 'running')
  if (fresh.length === 0) return
  await update($, runs, l => {
    const added: Run[] = []
    for (const a of fresh) {
      added.push({
        id: `agent-${a.id}`,
        kind: 'agent',
        name: a.type || 'agent',
        detail: a.description,
        status: 'running',
        startedAt: now,
        tools: 0,
        hue: nextHue([...l, ...added]),
        agentId: a.id,
      })
    }
    return [...l, ...added].slice(-MAX_RUNS)
  })
}

// Sync agent runs with what the engine reports, adding any it runs that the
// pane has not seen, and learn from the ones that just finished successfully.
const pollAgents = async ($: EngineInterface) => {
  const agents = await $.agent.list()
  const byId = new Map(agents.map(a => [a.id, a]))
  const now = await $.clock.now()
  await discoverAgents($, agents, now)
  const list = await read($, runs)

  const changes = new Map<string, Partial<Run>>()
  const finished: Run[] = []
  for (const r of list) {
    const info = r.kind === 'agent' && r.agentId ? byId.get(r.agentId) : undefined
    if (!info) continue
    const status = toStatus(info.status)
    if (status === r.status) continue
    const change: Partial<Run> = { status, endedAt: status === 'running' ? undefined : now }
    if (status === 'done' && !r.isLearned) {
      change.isLearned = true
      finished.push(r)
    }
    changes.set(r.id, change)
  }
  if (changes.size === 0) return

  await update($, runs, l =>
    l.map(r => {
      const change = changes.get(r.id)
      return change ? { ...r, ...change } : r
    }),
  )
  for (const r of finished) await learn($, r.name, now - r.startedAt)
}

// A token count in a few characters: 950, 12.3k, 4.1M.
const tokens = (n: number) =>
  n < 1_000 ? String(n) : n < 1_000_000 ? `${(n / 1_000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`

// Time left until a window resets: 3d 4h, 2h 14m, 9m.
const until = (ms: number) => {
  const minutes = Math.max(0, Math.ceil(ms / 60_000))
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
}

// Keep the engine's latest rate-limit readings and cost, session first.
const applyMeasure = ($: EngineInterface, limits: readonly Limit[], cost: SessionCost | undefined) => {
  const rank = (l: Limit) => {
    const i = LIMIT_ORDER.indexOf(l.kind)
    return i === -1 ? LIMIT_ORDER.length : i
  }
  const sorted = [...limits].sort((a, b) => rank(a) - rank(b)).map(l => ({ ...l }))
  return update($, usage, u => ({ ...u, limits: sorted, usd: cost?.usd ?? u.usd }))
}

// This week's count from the store; zero once its window has reset.
const savedWeek = async ($: EngineInterface, now: number) => {
  const saved = (await $.store.get(WEEK_KEY).catch(() => undefined)) as WeekTokens | undefined
  return saved && Date.parse(saved.resetsAt) > now ? saved : undefined
}

// Add one turn's tokens to the session's count and to this week's, which is
// kept in the store and starts over when the weekly window resets (its reset
// time as the engine reports it, else a week from the first count). Turns
// finish in parallel across agents, so week updates run one at a time.
let weekChain: Promise<unknown> = Promise.resolve()
const countTokens = ($: EngineInterface, u: ModelUsage) => {
  const n = u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  if (n === 0) return Promise.resolve()
  const run = async () => {
    await update($, usage, x => ({ ...x, sessionTokens: x.sessionTokens + n }))
    const now = await $.clock.now()
    const saved = await savedWeek($, now)
    // A reported reset already past is a reading from before the window
    // rolled over: saved with it, the next turn would start the count over.
    const reported = (await read($, usage)).limits.find(l => l.kind === WEEK_KIND)?.resetsAt
    const isReportedLive = reported !== undefined && Date.parse(reported) > now
    const week: WeekTokens = {
      tokens: (saved?.tokens ?? 0) + n,
      resetsAt: (isReportedLive ? reported : undefined) ?? saved?.resetsAt ?? new Date(now + WEEK_MS).toISOString(),
    }
    await $.store.set(WEEK_KEY, week)
    await update($, usage, x => ({ ...x, weekTokens: week.tokens }))
  }
  weekChain = weekChain.then(run, run)
  return weekChain
}

// ---------------------------------------------------------------- mascot

// How Clawd looks: the kind of work in hand, a call that just failed, the
// cheer when a turn ends, or resting.
type Look = Mood | 'fail' | 'cheer' | 'rest'

// Clawd, 4 rows tall. While busy it shuffles its feet, waves its arms, bobs
// and blinks now and then; idle it sits still with its eyes shut. Cheering,
// its arms stay up and it hops. `propRow` is where its prop goes: on the head
// row for thought dots and sparkles, else beside its arms.
const mascot = (n: number, look: Look) => {
  const isBusy = look !== 'rest'
  const isCheer = look === 'cheer'
  const f = n % 8
  const isBlink = !isBusy || (!isCheer && n % 17 === 0)
  const isArmsUp = isCheer || (isBusy && f % 2 === 1)
  const isFeetSwapped = isBusy && f % 4 >= 2
  const isBobUp = isCheer ? f % 2 === 0 : isBusy && (f === 2 || f === 6)

  const head = isArmsUp
    ? isBlink ? '▗▐█████▌▖' : '▗▐▛███▜▌▖'
    : isBlink ? ' ▐█████▌ ' : ' ▐▛███▜▌ '
  const body = isArmsUp ? ' ▜█████▛ ' : '▝▜█████▛▘'
  const feet = isFeetSwapped ? '  ▝▝ ▘▘  ' : '  ▘▘ ▝▝  '
  const blank = '         '

  const lines = isBobUp ? [head, body, feet, blank] : [blank, head, body, feet]
  const headRow = isBobUp ? 0 : 1
  const propRow = look === 'think' || isCheer || isArmsUp ? headRow : headRow + 1
  return { lines, propRow }
}

// What Clawd holds for each look, a frame every half second, 3 columns wide
// so the words beside it never shift: thought dots, a pen, a page, a
// magnifier, a prompt, a globe, a signpost, a question, a spark of alarm.
const PROP_WIDTH = 3
const PROPS: Record<Look, string[]> = {
  think: ['.', '..', '...'],
  write: ['✎', ' ✎'],
  read: ['▤', '▥'],
  search: ['⌕', ' ⌕'],
  edit: ['✎', '✐'],
  run: ['>_', '> '],
  web: ['◎', '◉'],
  agent: ['»', ' »'],
  ask: ['?', ' ?'],
  tool: ['◆', '◇'],
  fail: ['!', '!!'],
  cheer: ['✦', ' ✧', '✧ ✦'],
  rest: [''],
}
const propOf = (look: Look, n: number) => {
  const frames = PROPS[look]
  return (frames[Math.floor(n / 2) % frames.length] ?? '').padEnd(PROP_WIDTH)
}
const propColor = (look: Look) =>
  look === 'fail' ? 'error' : look === 'cheer' ? 'success' : look === 'ask' ? 'warning' : HOT

// The word beside Clawd for each look.
const FEELS: Record<Look, string> = {
  think: 'thinking',
  write: 'writing',
  read: 'reading',
  search: 'searching',
  edit: 'editing',
  run: 'running a command',
  web: 'browsing the web',
  agent: 'agents working',
  ask: 'waiting for you',
  tool: 'using a tool',
  fail: 'hit a snag',
  cheer: 'done!',
  rest: 'resting  z z',
}

// The feed's icon for each kind of work.
const ICONS: Record<Mood, string> = {
  think: '…',
  write: '✎',
  read: '▤',
  search: '⌕',
  edit: '✎',
  run: '›',
  web: '◎',
  agent: '»',
  ask: '?',
  tool: '◆',
}

// Whether Clawd still cheers the last turn: it ended neither stopped nor
// failed, and less than CHEER_MS (plus `slack`) ago.
const isCheerAt = (s: TurnSummary | null, now: number, slack = 0) =>
  s !== null && !s.isAborted && !s.isFailed && now - s.endedAt < CHEER_MS + slack

const SPIN = ['◐', '◓', '◑', '◒']

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'clawd-at-work',
      description: 'Open the Claude at work pane (animated Clawd + skill/agent tracker)',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    // The plan tool, listed up front (not behind ToolSearch) so Claude reaches for it.
    await $.tool
      .register({
        name: PLAN_TOOL,
        description:
          'Show your step-by-step plan for the current task in the "Claude at work" pane, ' +
          'where it drives the progress bar. Pass the whole list every time: each step a short ' +
          'title and a status (pending, active or done). Call it when you start a multi-step ' +
          'task and again whenever a step starts or finishes.',
        inputSchema: {
          type: 'object',
          properties: {
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'What the step does, in a few words' },
                  status: { type: 'string', enum: ['pending', 'active', 'done'] },
                },
                required: ['title', 'status'],
              },
            },
          },
          required: ['steps'],
        },
        isDeferred: false,
      })
      .catch(() => {})

    // Bring the learned averages from earlier sessions into this one.
    const saved = await $.store.get(STORE_KEY).catch(() => undefined)
    if (saved && typeof saved === 'object') await update($, typical, () => saved as Typical)

    // Usage as the status line has it now, and this week's tokens so far.
    const measured = await $.session.usage().catch(() => undefined)
    if (measured) await applyMeasure($, measured.rateLimits, measured.cost).catch(() => {})
    const week = await savedWeek($, await $.clock.now())
    await update($, usage, u => ({ ...u, weekTokens: week?.tokens ?? 0 }))

    // One ticker for the whole session: animates while busy and polls agent
    // status. Module variables reset on reload; the timer restarts with it.
    let tick = 0
    let isTicking = false
    $.clock.every(TICK_MS, () => {
      if (isTicking) return
      isTicking = true
      void (async () => {
        tick += 1
        const list = await read($, runs)
        const isTurnBusy = (await read($, busySince)) !== null
        const hasRunningAgent = list.some(r => r.kind === 'agent' && r.status === 'running')

        // Every second while agents run; every couple of seconds otherwise, to
        // find agents that start with no agent.spawn.
        if ((hasRunningAgent && tick % POLL_EVERY === 0) || tick % DISCOVER_EVERY === 0) await pollAgents($)
        const isActive = isTurnBusy || hasRunningAgent
        // Clawd's cheer after a turn, and a frame or two more to settle back.
        const isCheering = !isActive && isCheerAt(await read($, summary), await $.clock.now(), 2 * TICK_MS)
        // Redraw while something is happening; idle, once a minute for the
        // reset countdowns.
        if (isActive || isCheering || tick % IDLE_REDRAW === 0) {
          await update($, frame, n => n + 1)
        }
      })()
        .catch(() => {})
        .finally(() => {
          isTicking = false
        })
    })

    return next(e)
  })

  on('command.run', { command: 'clawd-at-work' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    return {
      text: opened.isPlaced
        ? 'Claude at work pane opened.'
        : `Claude at work pane is waiting: ${opened.reason}`,
    }
  })

  // A prompt the person sends is a new task: finished agents and skills are
  // cleared so every bar starts over, while agents still running carry on.
  // Agent-finished notifications start turns without a prompt, so they don't
  // clear a row the moment it reaches 100%.
  on('prompt.submit', async ($, e, next) => {
    await update($, runs, list => list.filter(r => r.status === 'running'))
    const live = new Set((await read($, runs)).map(r => r.id))
    await update($, expanded, ids => ids.filter(id => live.has(id)))
    await update($, plan, () => [])
    await update($, autoSteps, () => [])
    await update($, feed, () => [])
    await update($, feedCount, () => 0)
    await update($, files, () => [])
    await update($, summary, () => null)
    return next(e)
    // The tracker only observes: if its bookkeeping fails, the prompt still goes.
  }).catch(($, e, next) => next(e))

  // Ask Claude, in its system prompt, to keep the plan tool up to date.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    return {
      sections: [...composed.sections, { id: 'clawd-at-work:plan', text: PLAN_NOTE, scope: 'session' }],
    }
  }).catch(($, e, next) => next(e))

  // The plan tool: Claude's declared steps replace the pane's plan. Only the
  // main conversation's plan is shown; a subagent's call changes nothing.
  // A registered tool's result must be text (the engine refuses an object).
  const answer = (text: string) => ({ result: text, text })
  on('tool.call', { tool: PLAN_TOOL_FULL }, async ($, e) => {
    if (e.agentId !== undefined) return answer("The pane shows the main conversation's plan only; nothing changed.")
    const steps = toSteps((e as unknown as Record<string, unknown>).steps, 'title', s =>
      s === 'active' || s === 'done' ? s : 'pending',
    )
    await applyPlan($, steps)
    const done = steps.filter(s => s.status === 'done').length
    return answer(`Plan shown: ${done}/${steps.length} steps done.`)
    // A pane problem must never fail Claude's call: answer that it was not shown.
  }).catch(() => answer('The plan could not be shown in the pane; carry on with the task.'))

  // Claude Code's own todo list, where a session has it, drives the plan too.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      const steps = toSteps(e.todos, 'content', s =>
        s === 'in_progress' ? 'active' : s === 'completed' ? 'done' : 'pending',
      )
      await applyPlan($, steps)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // Main-loop turns drive the "working" state; a subagent's turn start
  // means that agent is active again (e.g. resumed by SendMessage).
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, busySince, () => now)
      await update($, main, () => ({ ...IDLE_MAIN, activity: 'thinking…', mood: 'think' as const }))
    } else {
      const id = e.agentId
      const isKnown = (await read($, runs)).some(r => r.kind === 'agent' && r.agentId === id)
      if (isKnown) {
        await patch($, r => r.kind === 'agent' && r.agentId === id, {
          status: 'running',
          endedAt: undefined,
        })
      } else {
        // A loop the pane has not seen (no agent.spawn): add its row now.
        await pollAgents($).catch(() => {})
      }
    }
    return next(e)
  })

  // The engine's rate-limit windows and cost, pushed as they move.
  on('session.measure', async ($, e, next) => {
    await applyMeasure($, e.rateLimits, e.cost)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const loop = e.agentId
    // Every loop's turn counts toward the session's and the week's tokens.
    if (e.usage) await countTokens($, e.usage).catch(() => {})
    // Skills stay "active" for the rest of the turn that loaded them.
    await patch($, r => r.kind === 'skill' && r.status === 'running' && r.loopId === loop, {
      status: e.isAborted ? 'failed' : 'done',
      endedAt: now,
    })
    if (loop === undefined) {
      // What the turn came to, for the Done line and Clawd's cheer.
      // An API error or a refusal ended it without an answer: no cheer.
      const ended = await read($, main)
      await update($, summary, () => ({
        durationMs: e.durationMs,
        tools: ended.tools,
        failed: ended.failed ?? 0,
        isAborted: e.isAborted,
        isFailed: e.reason === 'error' || e.reason === 'refusal',
        endedAt: now,
      }))
      await update($, busySince, () => null)
      await update($, main, () => IDLE_MAIN)
      await finishAuto($).catch(() => {})
      // Learn how long a main turn usually takes; interrupted or failed ones
      // would skew it.
      if (e.reason === 'answer') await learn($, MAIN_KEY, e.durationMs).catch(() => {})
    } else {
      // An agent's turn ended: ask the engine for its real status now.
      await pollAgents($).catch(() => {})
    }
    return next(e)
  })

  // Each model request of a main turn: "thinking…" while it thinks, then
  // what the streamed reply turns into (text, or the tool it is about to use).
  // It is also an auto step: Thinking, retitled Writing reply once text
  // streams. Writes are not awaited so the stream is never held up by the pane.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    void update($, main, m => ({ ...m, steps: m.steps + 1, activity: 'thinking…', mood: 'think' as const })).catch(
      () => {},
    )
    void startAuto($, 'think', 'think', 'Thinking').catch(() => {})
    let last = 'thinking'
    for await (const c of next(e)) {
      const kind = c.kind === 'tool' ? `tool:${c.name}` : c.kind === 'text' || c.kind === 'thinking' ? c.kind : last
      if (kind !== last) {
        last = kind
        const activity =
          c.kind === 'tool' ? `getting ready: ${toolName(c.name)}…` : kind === 'text' ? 'writing reply…' : 'thinking…'
        // Clawd picks up the tool's prop as soon as the call starts streaming.
        const mood: Mood = c.kind === 'tool' ? moodOf(c.name) : kind === 'text' ? 'write' : 'think'
        void setActivity($, activity, mood).catch(() => {})
        if (kind === 'text') void retitleAuto($, 'Writing reply').catch(() => {})
      }
      yield c
    }
  })

  // Every tool call inside an agent's loop is counted on that agent's row
  // and listed in its dropdown, running until the tool answers. A main-loop
  // call shows under the Claude bar instead, and is an auto step until it
  // answers (the plan tool itself is not one: it is the plan).
  on('tool.call', async ($, e, next) => {
    const loop = e.agentId
    const input = e as unknown as Record<string, unknown>
    if (loop === undefined) {
      const target = targetOf(input)
      const mood = moodOf(e.tool)
      await update($, main, m => ({ ...m, tools: m.tools + 1, mood, activity: doingTitle(e.tool, target) }))
      if (e.tool === PLAN_TOOL_FULL) return next(e)
      // Step, feed and file bookkeeping never gets in the way of the call itself.
      const id = e.tool_use_id
      await startAuto($, 'tool', `${e.tool}:${target}`, actionTitle(e.tool, target)).catch(() => {})
      const startedAt = await $.clock.now()
      await pushFeed($, { id, title: actionTitle(e.tool, target), mood, status: 'running', startedAt }).catch(() => {})
      const ran = await next(e)
      // Nothing after the call may throw: the hook's catch would run it again.
      const isFailed = ran.deny !== undefined || ran.isError === true
      const endedAt = await $.clock.now().catch(() => startedAt)
      await finishAuto($).catch(() => {})
      await patchFeed($, id, { status: isFailed ? 'failed' : 'done', endedAt }).catch(() => {})
      if (isFailed) await update($, main, m => ({ ...m, failed: (m.failed ?? 0) + 1, failedAt: endedAt })).catch(() => {})
      else await touch($, e.tool, input, true).catch(() => {})
      return ran
    }

    const call: Call = {
      id: e.tool_use_id,
      tool: e.tool,
      target: targetOf(input),
      status: 'running',
      startedAt: await $.clock.now(),
    }
    await update($, runs, list =>
      list.map(r =>
        r.kind === 'agent' && r.agentId === loop
          ? { ...r, tools: (r.tools ?? 0) + 1, calls: [...(r.calls ?? []), call].slice(-MAX_CALLS) }
          : r,
      ),
    )
    const ran = await next(e)
    const isFailed = ran.deny !== undefined || ran.isError === true
    const endedAt = await $.clock.now().catch(() => call.startedAt)
    await patchCall($, loop, call.id, { status: isFailed ? 'failed' : 'done', endedAt }).catch(() => {})
    if (!isFailed) await touch($, e.tool, input, false).catch(() => {})
    return ran
  }).catch(($, e, next) => next(e))

  // Skills: recorded when the Skill tool is called.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const now = await $.clock.now()
    const id = e.tool_use_id
    await add($, {
      id,
      kind: 'skill',
      name: e.skill,
      detail: '',
      status: 'running',
      startedAt: now,
      loopId: e.agentId,
    })
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) {
      // Guarded: a throw here would reach the .catch, which runs the call again.
      await $.clock
        .now()
        .then(endedAt => patch($, r => r.id === id, { status: 'failed', endedAt }))
        .catch(() => {})
    }
    return ran
    // The tracker only observes: if its bookkeeping fails, let the call through.
  }).catch(($, e, next) => next(e))

  // Agents: recorded as the spawn starts; the ticker keeps their status.
  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    const id = e.tool_use_id
    await update($, runs, list => {
      const run: Run = {
        id,
        kind: 'agent',
        name: e.subagentType || 'agent',
        detail: e.description,
        status: 'running',
        startedAt: now,
        tools: 0,
        hue: nextHue(list),
      }
      return [...list, run].slice(-MAX_RUNS)
    })
    const out = await next(e)
    // Guarded: a throw here would reach the .catch, which spawns the agent again.
    const agentId = out.agentId
    if (agentId) {
      await patch($, r => r.id === id, { agentId }).catch(() => {})
    } else {
      // Refused or answered by a hook: nothing actually started.
      await $.clock
        .now()
        .then(endedAt => patch($, r => r.id === id, { status: 'failed', endedAt }))
        .catch(() => {})
    }
    return out
  }).catch(($, e, next) => next(e))

  // ---------------------------------------------------------------- pane

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const open = await read($, expanded)
    const n = await read($, frame)
    const since = await read($, busySince)
    const list = await read($, runs)
    const learned = await read($, typical)
    const planNow = await read($, plan)
    const autoNow = await read($, autoSteps)
    // A declared plan wins; otherwise the steps made from what Claude does.
    const isAuto = planNow.length === 0 && autoNow.length > 0
    const stepsNow = isAuto ? autoNow : planNow
    const now = await $.clock.now()

    const agents = list.filter(r => r.kind === 'agent')
    const skills = list.filter(r => r.kind === 'skill')
    const runningAgents = agents.filter(r => r.status === 'running').length
    const [mainNow, feedNow, feedTotal, filesNow, summaryNow, usageNow] = await Promise.all([
      read($, main),
      read($, feed),
      read($, feedCount),
      read($, files),
      read($, summary),
      read($, usage),
    ])

    // Clawd's look: while a turn runs, the kind of work in hand (or a call
    // that just failed); after it, a short cheer; then agents, else rest.
    const isCheer = since === null && isCheerAt(summaryNow, now)
    const look: Look =
      since !== null
        ? mainNow.failedAt !== undefined && now - mainNow.failedAt < FAIL_MS
          ? 'fail'
          : (mainNow.mood ?? 'think')
        : isCheer
          ? 'cheer'
          : runningAgents > 0
            ? 'agent'
            : 'rest'
    const isBusy = look !== 'rest'

    const label = FEELS[look]
    const elapsed = since !== null ? clock(now - since) : ''
    const counts = `${plural(agents.length, 'agent')} · ${plural(skills.length, 'skill')}`

    // Rows left under the mascot (4) + spacer + 2 headings. Agents get ~70%
    // of the room, newest first: two rows each, plus an open dropdown's
    // tool lines. Skills get the rest.
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    // A declared plan shows a window starting just before its first
    // unfinished step; auto steps show the newest, the one in progress last.
    const planDone = stepsNow.filter(s => s.status === 'done').length
    const firstOpen = Math.max(0, stepsNow.findIndex(s => s.status !== 'done'))
    const planStart = isAuto
      ? Math.max(0, stepsNow.length - SHOWN_STEPS)
      : Math.max(0, Math.min(firstOpen - 2, stepsNow.length - SHOWN_STEPS))
    const stepsShown = stepsNow.slice(planStart, planStart + SHOWN_STEPS)
    // Above the lists: the Claude bar, its activity line and a spacer while a
    // turn runs (3); the plan's heading, its shown steps (an active one with
    // its bar beneath) and a spacer.
    const planRows =
      stepsShown.length > 0 ? 2 + stepsShown.length + stepsShown.filter(s => s.status === 'active').length : 0
    // Usage: heading, a row per limit window (or one saying none), tokens, spacer.
    const usageRows = 3 + Math.max(1, usageNow.limits.length)
    // Recent shows only under a declared plan: its heading and newest calls.
    const feedShown = planNow.length > 0 ? feedNow.slice(-FEED_SHOWN) : []
    const feedRows = feedShown.length > 0 ? 1 + feedShown.length : 0
    const filesRows = filesNow.length > 0 ? 1 : 0
    // The Done line and a spacer, in the Claude bar's place while idle.
    const isSummaryShown = since === null && summaryNow !== null
    const summaryRows = isSummaryShown ? 2 : 0
    const room = Math.max(
      3,
      bodyRows - 8 - (since !== null ? 3 : 0) - planRows - usageRows - feedRows - filesRows - summaryRows,
    )
    const agentBudget = Math.max(2, Math.floor(room * 0.7))
    // Every running agent always shows: it is live work, so it is never hidden
    // for space. When two rows each (title and bar) would not fit them all,
    // every row goes compact, one line each. Finished agents fill what is
    // left, newest first, and a last line counts the ones that did not fit.
    const runningAgentRuns = agents.filter(r => r.status === 'running')
    const isCompact = runningAgentRuns.length * 2 > agentBudget
    const heightOf = (r: Run) =>
      isCompact ? 1 : 2 + (open.includes(r.id) ? Math.max(1, Math.min(SHOWN_CALLS, r.calls?.length ?? 0)) : 0)
    const picked = new Set(runningAgentRuns.map(r => r.id))
    let used = runningAgentRuns.reduce((sum, r) => sum + heightOf(r), 0)
    for (const r of [...agents].reverse()) {
      if (picked.has(r.id)) continue
      // With nothing running, the newest agent still shows, even past the budget.
      if (picked.size > 0 && used + heightOf(r) > agentBudget) break
      picked.add(r.id)
      used += heightOf(r)
    }
    const shownAgents = agents.filter(r => picked.has(r.id))
    const hiddenAgents = agents.length - shownAgents.length
    const skillRoom = Math.max(1, room - Math.max(2, used + (hiddenAgents > 0 ? 1 : 0)))

    // The bar fills what the row leaves after indent, percent, time and tools.
    const columns = e.props.bodyColumns ?? 40
    const barWidth = Math.max(12, Math.min(28, columns - 24))

    const glyphOf = (r: Run) =>
      r.status === 'running' ? SPIN[n % SPIN.length] : r.status === 'done' ? '✓' : '✗'
    const colorOf = (r: Run) =>
      r.status === 'failed' ? 'error' : r.status === 'running' ? ORANGE : 'success'

    // Compact agent, one line: status, type, %, time and tools, then its task.
    const compactAgentRow = (r: Run) => {
      const color = r.status === 'failed' ? 'error' : PALETTE[(r.hue ?? 0) % PALETTE.length]
      return (
        <Text wrap="truncate-end">
          {' '}
          <Text color={r.status === 'running' ? color : colorOf(r)}>{`${glyphOf(r)} `}</Text>
          {r.name}
          <Text color={color}>{` ${String(percent(r, learned, now)).padStart(3)}%`}</Text>
          <Text dimColor>{`  ${clock((r.endedAt ?? now) - r.startedAt)} · ${plural(r.tools ?? 0, 'tool')}  ${r.detail}`}</Text>
        </Text>
      )
    }

    // Agent: line 1 status, type and task; line 2 a thin bar in the agent's
    // own color with a mini Clawd running at its head, then %, time, tools.
    const agentRow = (r: Run) => {
      const pct = percent(r, learned, now)
      const color = r.status === 'failed' ? 'error' : PALETTE[(r.hue ?? 0) % PALETTE.length]
      const track = barWidth - RUNNER[0]!.length
      const filled = Math.round((pct / 100) * track)
      // Offset each agent's blink by its color slot so they don't blink in sync.
      const isBlink = (n + (r.hue ?? 0) * 5) % BLINK_EVERY === BLINK_EVERY - 1
      const runner =
        r.status === 'running'
          ? isBlink ? RUNNER_BLINK : RUNNER[n % RUNNER.length]
          : r.status === 'done' ? RUNNER_DONE : RUNNER_FAILED
      const time = clock((r.endedAt ?? now) - r.startedAt)
      const tools = `${r.tools ?? 0} tool${r.tools === 1 ? '' : 's'}`
      const isOpen = open.includes(r.id)
      // A Button cannot truncate, so cut the task description to fit.
      const detailRoom = Math.max(0, columns - r.name.length - 8)
      const detail =
        r.detail.length > detailRoom ? `${r.detail.slice(0, Math.max(0, detailRoom - 1))}…` : r.detail
      const toggle = () =>
        update($, expanded, ids => (ids.includes(r.id) ? ids.filter(id => id !== r.id) : [...ids, r.id]))
      const calls = (r.calls ?? []).slice(-SHOWN_CALLS)
      return (
        <Box flexDirection="column">
          <Button key={`agent-${r.id}`} plain onPress={toggle}>
            {isOpen ? '▾ ' : '▸ '}
            <Text color={r.status === 'running' ? color : colorOf(r)}>{`${glyphOf(r)} `}</Text>
            {r.name}
            <Text dimColor>{detail ? `  ${detail}` : ''}</Text>
          </Button>
          <Text wrap="truncate-end">
            {'    '}
            <Text color={color}>{'━'.repeat(filled)}</Text>
            <Text color={color} bold>{runner}</Text>
            <Text dimColor>{'─'.repeat(track - filled)}</Text>
            {` ${String(pct).padStart(3)}%`}
            <Text dimColor>{`  ${time} · ${tools}`}</Text>
          </Text>
          {isOpen && calls.length === 0 && <Text dimColor>{'      no tool calls yet'}</Text>}
          {isOpen &&
            calls.map(c => (
              <Text wrap="truncate-end" dimColor={c.status === 'done'}>
                {'      '}
                <Text color={c.status === 'failed' ? 'error' : c.status === 'running' ? color : 'success'}>
                  {c.status === 'running' ? SPIN[n % SPIN.length] : c.status === 'done' ? '✓' : '✗'}
                </Text>
                {` ${c.tool.padEnd(6)} ${c.target}`}
                <Text dimColor>{c.endedAt === undefined ? '' : `  ${short(c.endedAt - c.startedAt)}`}</Text>
              </Text>
            ))}
        </Box>
      )
    }

    const skillRow = (r: Run) => (
      <Text
        wrap="truncate-end"
        dimColor={r.status === 'done'}
        color={r.status === 'failed' ? 'error' : r.status === 'running' ? ORANGE : undefined}
      >
        {` ${glyphOf(r)} ${r.name}  ${clock((r.endedAt ?? now) - r.startedAt)}`}
      </Text>
    )

    // Claude: real progress through the plan Claude declared when there is
    // one (the mean of its steps' bars); otherwise the turn's estimate
    // (elapsed / its learned typical time, held below 100% until the turn
    // ends). A mini Clawd runs at the head, and what Claude is doing right
    // now shows beneath.
    const mainPct =
      planNow.length > 0
        ? planPercent(planNow, learned, now)
        : since === null
          ? 0
          : Math.min(MAX_ESTIMATE, Math.floor(((now - since) / typicalMs(learned, MAIN_KEY)) * 100))
    const mainWidth = Math.max(14, Math.min(40, columns - 28))

    // Plan: each step's title gets the whole line, so it reads in a narrow
    // pane: ✓ done, ○ pending. The active step has its bar on a line of its
    // own beneath, filling by time with the mini Clawd running at its head.
    const titleWidth = Math.max(8, columns - 4)
    const stepWidth = Math.max(RUNNER[0]!.length + 3, Math.min(28, columns - 18))
    const stepRow = (s: PlanStep) => {
      const full = s.count !== undefined && s.count > 1 ? `${s.title} ×${s.count}` : s.title
      const isActive = s.status === 'active'
      const head = (
        <Text wrap="truncate-end">
          {'  '}
          <Text color={s.status === 'done' ? 'success' : isActive ? HOT : undefined} dimColor={s.status === 'pending'}>
            {s.status === 'done' ? '✓' : isActive ? SPIN[n % SPIN.length] : '○'}
          </Text>
          <Text dimColor={!isActive}>{` ${clip(full, titleWidth)}`}</Text>
        </Text>
      )
      if (!isActive) return head
      const pct = stepPercent(s, learned, now)
      const track = stepWidth - RUNNER[0]!.length
      const filled = Math.round((pct / 100) * track)
      return (
        <Box flexDirection="column">
          {head}
          <Text wrap="truncate-end">
            {'    '}
            <Text color={HOT}>{'━'.repeat(filled)}</Text>
            <Text color={HOT} bold>{RUNNER[n % RUNNER.length]}</Text>
            <Text dimColor>{'─'.repeat(track - filled)}</Text>
            {` ${String(pct).padStart(3)}%`}
            <Text dimColor>{`  ${clock(now - (s.startedAt ?? now))}`}</Text>
          </Text>
        </Box>
      )
    }
    const planRowsShown = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{isAuto ? ' Steps    ' : ' Plan     '}</Text>
          <Text dimColor>
            {isAuto ? `${planDone} done · auto` : `${planDone}/${planNow.length} steps done`}
          </Text>
        </Text>
        {stepsShown.map(stepRow)}
      </Box>
    )
    const mainTrack = mainWidth - RUNNER[0]!.length
    const mainFilled = Math.round((mainPct / 100) * mainTrack)
    const mainRunner = n % BLINK_EVERY === BLINK_EVERY - 1 ? RUNNER_BLINK : RUNNER[n % RUNNER.length]
    const mainRows = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{' Claude   '}</Text>
          <Text color={HOT}>{'━'.repeat(mainFilled)}</Text>
          <Text color={HOT} bold>{mainRunner}</Text>
          <Text dimColor>{'─'.repeat(mainTrack - mainFilled)}</Text>
          {` ${String(mainPct).padStart(3)}%`}
          <Text dimColor>{`  ${elapsed}`}</Text>
        </Text>
        <Text wrap="truncate-end">
          {'          '}
          <Text color={HOT}>{mainNow.activity || 'thinking…'}</Text>
          <Text dimColor>{`  step ${mainNow.steps} · ${mainNow.tools} tool${mainNow.tools === 1 ? '' : 's'}`}</Text>
        </Text>
      </Box>
    )

    // Usage: each rate-limit window's bar, how much is used and when it
    // resets; then the tokens this session and this week, and the cost.
    const limitWidth = Math.max(8, Math.min(24, columns - 34))
    const limitRow = (l: Limit) => {
      const pct = Math.round(l.percentUsed)
      const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * limitWidth)
      const color = pct >= ALERT_AT ? 'error' : pct >= WARN_AT ? 'warning' : 'success'
      const left = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt) - now
      const name = (LIMIT_NAMES[l.kind] ?? l.kind).slice(0, 8).padEnd(8)
      return (
        <Text wrap="truncate-end">
          <Text bold>{` ${name} `}</Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(limitWidth - filled)}</Text>
          <Text color={pct >= WARN_AT ? color : undefined}>{` ${String(pct).padStart(3)}%`}</Text>
          <Text dimColor>{Number.isNaN(left) ? '' : `  resets in ${until(left)}`}</Text>
        </Text>
      )
    }
    const usageRowsShown = (
      <Box flexDirection="column">
        <Text bold>Usage</Text>
        {usageNow.limits.length === 0 ? (
          <Text dimColor wrap="truncate-end"> no limit reading yet</Text>
        ) : (
          usageNow.limits.map(limitRow)
        )}
        <Text wrap="truncate-end">
          <Text bold>{' Tokens   '}</Text>
          {`${tokens(usageNow.sessionTokens)} session · ${tokens(usageNow.weekTokens)} week`}
          <Text dimColor>{usageNow.usd === undefined ? '' : ` · $${usageNow.usd.toFixed(2)}`}</Text>
        </Text>
        <Text> </Text>
      </Box>
    )

    // Recent: the main loop's newest calls under a declared plan, each with
    // its kind's icon (✗ once failed), what it did and how long it took.
    const feedTitleWidth = Math.max(8, columns - 12)
    const feedRow = (f: FeedItem) => {
      const title = clip(f.title, feedTitleWidth).padEnd(feedTitleWidth)
      return (
        <Text wrap="truncate-end">
          {'  '}
          <Text color={f.status === 'failed' ? 'error' : f.status === 'running' ? HOT : 'success'}>
            {f.status === 'failed' ? '✗' : ICONS[f.mood]}
          </Text>
          <Text dimColor={f.status === 'done'}>{` ${title}`}</Text>
          <Text dimColor>{f.endedAt === undefined ? '' : ` ${short(f.endedAt - f.startedAt)}`}</Text>
        </Text>
      )
    }
    const feedRowsShown = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>{' Recent   '}</Text>
          <Text dimColor>{plural(feedTotal, 'action')}</Text>
        </Text>
        {feedShown.map(feedRow)}
      </Box>
    )

    // Files: edited ones first, then ones only read, packed into one row with
    // a count of those that do not fit.
    const edited = filesNow.filter(f => f.isEdited)
    const readOnly = filesNow.filter(f => !f.isEdited)
    const fileRoom = columns - 10
    const packed: TouchedFile[] = []
    let packedWidth = 0
    for (const f of [...edited, ...readOnly]) {
      const width = f.name.length + 4
      const more = filesNow.length - packed.length - 1 > 0 ? 3 : 0
      if (packed.length > 0 && packedWidth + width + more > fileRoom) break
      packed.push(f)
      packedWidth += width
    }
    const hiddenFiles = filesNow.length - packed.length
    const filesRow = (
      <Text wrap="truncate-end">
        <Text bold>{' Files    '}</Text>
        {packed.map(f => (
          <Text color={f.isEdited ? HOT : undefined} dimColor={!f.isEdited}>
            {`${f.isEdited ? '✎' : '◦'} ${f.name}  `}
          </Text>
        ))}
        <Text dimColor>{hiddenFiles > 0 ? `+${hiddenFiles}` : ''}</Text>
      </Text>
    )

    // Done: what the last turn came to, until the next prompt: stopped by
    // the person, failed on an API error or a refusal, or done.
    const ending = summaryNow?.isAborted
      ? { word: ' Stopped  ', color: 'warning', mark: '■ ' }
      : summaryNow?.isFailed
        ? { word: ' Failed   ', color: 'error', mark: '✗ ' }
        : { word: ' Done     ', color: 'success', mark: '✓ ' }
    const summaryRow = summaryNow && (
      <Text wrap="truncate-end">
        <Text bold>{ending.word}</Text>
        <Text color={ending.color}>{ending.mark}</Text>
        {clock(summaryNow.durationMs)}
        <Text dimColor>
          {[
            edited.length > 0
              ? `${plural(edited.length, 'file')} edited`
              : readOnly.length > 0
                ? `${plural(readOnly.length, 'file')} read`
                : '',
            plural(summaryNow.tools, 'tool'),
          ]
            .filter(s => s !== '')
            .map(s => ` · ${s}`)
            .join('')}
        </Text>
        <Text color="error">{summaryNow.failed > 0 ? ` · ${summaryNow.failed} failed` : ''}</Text>
      </Text>
    )

    const art = mascot(n, look)
    const prop = propOf(look, n)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexDirection="column">
            {art.lines.map((line, i) => (
              <Text>
                <Text color={ORANGE} dimColor={!isBusy}>
                  {line}
                </Text>
                <Text color={propColor(look)} bold>
                  {i === art.propRow ? prop : ' '.repeat(PROP_WIDTH)}
                </Text>
              </Text>
            ))}
          </Box>
          <Box flexDirection="column" marginLeft={2}>
            <Text> </Text>
            <Text bold color={isBusy ? ORANGE : undefined} dimColor={!isBusy}>
              {label}
            </Text>
            <Text dimColor>{elapsed}</Text>
            <Text dimColor>{counts}</Text>
          </Box>
        </Box>
        <Text> </Text>
        {usageRowsShown}
        {since !== null && mainRows}
        {isSummaryShown && summaryRow}
        {stepsNow.length > 0 && planRowsShown}
        {feedShown.length > 0 && feedRowsShown}
        {filesNow.length > 0 && filesRow}
        {(since !== null || stepsNow.length > 0 || isSummaryShown || filesNow.length > 0) && <Text> </Text>}
        <Text wrap="truncate-end">
          <Text bold>Agents</Text>
          <Text dimColor>
            {runningAgentRuns.length > 0
              ? `   ${runningAgentRuns.length} running${agents.length > runningAgentRuns.length ? ` · ${agents.length - runningAgentRuns.length} done` : ''}`
              : ''}
          </Text>
        </Text>
        {agents.length === 0 ? (
          <Text dimColor> none yet</Text>
        ) : (
          shownAgents.map(isCompact ? compactAgentRow : agentRow)
        )}
        {hiddenAgents > 0 && <Text dimColor>{` +${hiddenAgents} more finished`}</Text>}
        <Text bold>Skills</Text>
        {skills.length === 0 ? (
          <Text dimColor> none yet</Text>
        ) : (
          skills.slice(-skillRoom).map(skillRow)
        )}
      </Box>
    )
  })
}
