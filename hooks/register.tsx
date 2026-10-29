import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface, ModelUsage, Register, SessionCost } from 'claude-code'

import type {
  Call,
  FeedItem,
  Limit,
  MainTurn,
  Mood,
  Peer,
  PlanStep,
  Run,
  SelfInfo,
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
// A search's pattern comes before the folder it searches in.
const TARGET_FIELDS = [
  'file_path',
  'notebook_path',
  'pattern',
  'path',
  'command',
  'url',
  'query',
  'skill',
  'description',
  'prompt',
]
const TARGET_MAX = 40

// The plan tool Claude calls to declare its steps; the model sees it as
// mcp__<plugin>__plan. A short system-prompt note asks Claude to use it.
const PLAN_TOOL = 'plan'
const PLAN_TOOL_FULL = 'mcp__clawd-at-work__plan'
const MAX_STEPS = 20
// Plan titles are kept up to this long; the pane cuts them to its width.
const STEP_MAX = 200
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

// Sessions: each session publishes its status in the store (one file shared
// by every session on this computer) under its own key, at most every
// SHARE_MS when it changes and at least every HEARTBEAT_MS. Others in the
// same project read it; one silent for PEER_STALE_MS drops off the list,
// and its key is removed after PEER_FORGET_MS.
const PEER_PREFIX = 'session:'
const SHARE_MS = 2_000
const HEARTBEAT_MS = 15_000
const PEER_STALE_MS = 60_000
const PEER_FORGET_MS = 10 * 60_000
const TASK_MAX = 60
const SHOWN_PEERS = 4

// Where a prompt comes from when it is the person giving a new task: typed at
// the terminal, sent from the SDK, Remote Control or Slack, a /loop or
// schedule firing their prompt, or a coordinator's hand-off.
const PERSON_ORIGINS = new Set(['composer', 'bridge', 'sdk', 'scheduled-trigger', 'slack-ping', 'channel', 'coordinator'])

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
const self = atom({ plugin: 'clawd-at-work', key: 'self' } as const, null)
const peers = atom({ plugin: 'clawd-at-work', key: 'peers' } as const, [])

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

// The emoji below U+1F300 that terminals draw two columns wide (✅ ❌ ✨ ⭐
// ⚡ ⌛ ...), as [first, last] code points.
const WIDE_SYMBOLS: [number, number][] = [
  [0x231a, 0x231b], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4],
  [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e],
  [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f2ff],
]

// Terminal columns one character takes: two for wide ones (CJK, fullwidth,
// emoji), none for combining marks and joiners.
const charWidth = (ch: string) => {
  const c = ch.codePointAt(0) ?? 0
  // Marks of any script (accents, Thai and Hindi vowels and tones) ride on the character before.
  if (/\p{M}/u.test(ch) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) return 0
  if (WIDE_SYMBOLS.some(([lo, hi]) => c >= lo && c <= hi)) return 2
  const isWide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  return isWide ? 2 : 1
}
// `text` as what a terminal draws: each character with the marks that ride
// on it (combining marks, joiners, variation selectors), and its columns.
// A symbol followed by U+FE0F asks for its emoji form, two columns (⚠️).
const glyphs = (text: string) => {
  const out: { text: string; width: number }[] = []
  for (const ch of text) {
    const w = charWidth(ch)
    const last = out.at(-1)
    if (w === 0 && last) {
      last.text += ch
      if (ch === '️' && last.width === 1 && (last.text.codePointAt(0) ?? 0) >= 0x2000) last.width = 2
    } else {
      out.push({ text: ch, width: w })
    }
  }
  return out
}
const textWidth = (text: string) => glyphs(text).reduce((w, g) => w + g.width, 0)

// `text` padded with spaces to `width` columns.
const padTo = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - textWidth(text)))

// `text` cut to at most `width` columns, ending in … when cut. It cuts
// between whole characters, so an emoji is never split in half.
const clip = (text: string, width: number) => {
  if (textWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const g of glyphs(text)) {
    if (used + g.width > width - 1) break
    out += g.text
    used += g.width
  }
  return `${out}…`
}

// Text from tool inputs as one plain line: its first line only, terminal
// escape sequences dropped and other control characters (which make the pane
// refuse to draw) turned into spaces.
const plainLine = (text: string) =>
  (text.split(/\r\n|\r|\n/)[0] ?? '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')

// A string field of a tool input or event as plain text, '' when missing.
const plainOf = (value: unknown) => (typeof value === 'string' ? plainLine(value) : '')

// A path's file name alone; a folder path ending in a slash gives its last folder.
const baseName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path

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
// A path in a command is cut to its last name, like a file tool's target,
// when it is three or more names deep (C:\Users\me, ~/a/b, src/lib/x.ts).
// A redirect or flag before it stays (2>, &>, --config=). Short paths
// (/dev/null, origin/main, hooks/x.ts), URLs, globs, patterns and escapes
// (s/a/b/g, "TODO\|FIXME", "\w+", 'a\tb') and quoted prose that is not a
// path ("fix and/or tidy docs/api") stay as they are. A backslash separates
// names only in a Windows path (C:\..., \\server\..., .\x); elsewhere it is
// an escape.
const SHELL_WORD = /"[^"]*"|'[^']*'|[^\s"']+/g
const PATH_LEAD = /^(?:\d*>>?|&>>?|--?[\w-]+=)/
// Brackets mark a pattern, and quotes inside a word mark code (`node -p
// "require('./a/b/c.json')"`). Parentheses may sit in a folder's name
// (`Program Files (x86)`, `app/(marketing)/`), but a last name holding one is
// code (`open('a/b/c.csv').read()`), so that word stays whole too.
const NOT_PATH = /[|[\]{}^$+*?'"`]|^[sy]\/|:\/\//
const shortPath = (word: string) => {
  const lead = PATH_LEAD.exec(word)?.[0] ?? ''
  const rest = word.slice(lead.length)
  const quote = /^["']/.test(rest) ? rest[0]! : ''
  const inner = quote ? rest.slice(1, -1) : rest
  if (NOT_PATH.test(inner) || /[()]/.test(inner.split(/[\\/]/).at(-1) ?? '')) return word
  const isWindows = /^(?:[A-Za-z]:[\\/]|\\\\|\.{1,2}\\)/.test(inner)
  const isAbsolute = isWindows || /^~?\//.test(inner)
  if (!isAbsolute && /\s/.test(inner)) return word
  if (!isWindows && inner.includes('\\')) return word
  const parts = inner.split(isWindows ? /[\\/]+/ : /\/+/).filter(Boolean)
  if (parts.length < 3) return word
  const name = parts.at(-1)!
  return lead + (/\s/.test(name) ? `${quote || '"'}${name}${quote || '"'}` : name)
}
const shellTarget = (command: string) => {
  let rest = command
  for (let m = CD_PREFIX.exec(rest); m && m[0].length < rest.length; m = CD_PREFIX.exec(rest)) {
    rest = rest.slice(m[0].length)
  }
  const only = CD_ONLY.exec(rest)
  return only ? `cd ${baseName(only[1]!.replace(/[\\/]+$/, ''))}` : rest.replace(SHELL_WORD, shortPath)
}

// What a tool call works on: the first naming field of its input, with a
// path cut to its file name and one plain line of at most TARGET_MAX columns.
const targetOf = (input: Record<string, unknown>) => {
  for (const field of TARGET_FIELDS) {
    const value = input[field]
    if (typeof value !== 'string' || value === '') continue
    const text = plainLine(field.endsWith('path') ? baseName(value) : field === 'command' ? shellTarget(value) : value)
    if (text.trim() === '') continue
    return clip(text, TARGET_MAX)
  }
  return ''
}

// A tool's display name: MCP tools read as `server tool name`, not
// mcp__server__tool_name.
const toolName = (name: string) =>
  name.startsWith('mcp__') ? name.split('__').slice(1).join(' ').replace(/_/g, ' ') : name

// The same, short, for a dropdown line: an MCP tool by its own name alone
// (`list issues`), so the target still fits.
const shortTool = (name: string) =>
  name.startsWith('mcp__') ? (name.split('__').at(-1) ?? name).replace(/_/g, ' ') : name

// Steps from a plan or TodoWrite call: titles trimmed to one short line,
// unknown statuses read as pending, at most MAX_STEPS kept.
const toSteps = (raw: unknown, title: string, status: (s: unknown) => PlanStep['status']): PlanStep[] =>
  (Array.isArray(raw) ? raw : []).slice(0, MAX_STEPS).flatMap(item => {
    const step = item as Record<string, unknown> | null
    const text = plainOf(step?.[title]).trim()
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

// The Claude bar's percent: real progress through a declared plan when there
// is one (the mean of its steps' bars); otherwise the turn's estimate
// (elapsed / its learned typical time, held below 100% until the turn ends).
const mainPercent = (planSteps: PlanStep[], t: Typical, since: number | null, now: number) =>
  planSteps.length > 0
    ? planPercent(planSteps, t, now)
    : since === null
      ? 0
      : Math.min(MAX_ESTIMATE, Math.floor(((now - since) / typicalMs(t, MAIN_KEY)) * 100))

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
    const file: TouchedFile = { path, name: plainLine(baseName(path)), isEdited: isEdit }
    const grown = [...list, file]
    if (grown.length <= MAX_FILES) return grown
    // Over the cap, the oldest file only read goes first, so edits stay listed.
    const drop = grown.findIndex(f => !f.isEdited)
    return grown.filter((_, i) => i !== (drop === -1 ? 0 : drop))
  })
}

// Finish every active auto step, teaching each kind's typical time. A tool
// step whose call failed is marked so, and shows ✗ instead of ✓.
const finishAuto = async ($: EngineInterface, isFailed = false) => {
  const steps = await read($, autoSteps)
  const active = steps.filter(s => s.status === 'active')
  if (active.length === 0) return
  const now = await $.clock.now()
  await update($, autoSteps, list =>
    list.map(s =>
      s.status === 'active'
        ? { ...s, status: 'done' as const, endedAt: now, isFailed: isFailed && s.kind === 'tool' ? true : undefined }
        : s,
    ),
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
      const count = (last.count ?? 1) + 1
      const merged = { ...last, status: 'active' as const, startedAt: now, endedAt: undefined, isFailed: undefined, count }
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
// Other sessions learn into the same store at the same time, so the store is
// read fresh and only this type's average changes in it.
const learn = async ($: EngineInterface, type: string, ms: number) => {
  const raw = await $.store.get(STORE_KEY).catch(() => undefined)
  const stored = raw && typeof raw === 'object' ? (raw as Typical) : {}
  await update($, typical, t => {
    const merged = { ...t, ...stored }
    const old = merged[type]
    const n = Math.min((old?.n ?? 0) + 1, LEARN_WINDOW)
    const avgMs = old ? old.avgMs + (ms - old.avgMs) / n : ms
    return { ...merged, [type]: { avgMs, n } }
  })
  const mine = (await read($, typical))[type]
  await $.store.set(STORE_KEY, { ...stored, [type]: mine })
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
        name: plainOf(a.type) || 'agent',
        detail: plainOf(a.description),
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

// A token count in a few characters: 950, 12.3k, 4.1M. Counts that would
// round up to 1000.0k read as millions.
const tokens = (n: number) =>
  n < 1_000 ? String(n) : n < 999_950 ? `${(n / 1_000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(1)}M`

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

// Whether two sessions work in the same project: the same folder, or one
// A session's project is its repository's main root (the same for each
// worktree) or its folder, so two match only when those are one folder; a
// session started in / or a home folder does not take in every other.
const sameProject = (a: string, b: string) => pathKey(a).replace(/\/+$/, '') === pathKey(b).replace(/\/+$/, '')

// A peer read back from the store, or undefined when it is not one.
const toPeer = (raw: unknown): Peer | undefined => {
  const p = raw as Partial<Peer> | null
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || typeof p.cwd !== 'string') return undefined
  if (typeof p.updatedAt !== 'number') return undefined
  const states: Peer['state'][] = ['working', 'waiting', 'done', 'failed', 'idle']
  return {
    id: p.id,
    cwd: p.cwd,
    task: plainOf(p.task),
    state: states.includes(p.state as Peer['state']) ? (p.state as Peer['state']) : 'idle',
    activity: plainOf(p.activity),
    percent: typeof p.percent === 'number' ? Math.max(0, Math.min(100, Math.round(p.percent))) : 0,
    updatedAt: p.updatedAt,
  }
}

// Publish this session's status for the other sessions, when it changed or
// the heartbeat is due, then read theirs: the fresh ones in the same project
// become the Sessions list, and long-silent ones are removed from the store.
// It runs at most once per SHARE_MS of clock time, however many ticks come;
// a clock that went back (a new session in this process) starts over.
let lastShared = ''
let lastSharedAt = 0
let lastCheckedAt = 0
const shareStatus = async ($: EngineInterface) => {
  const me = await read($, self)
  if (me === null) return
  const now = await $.clock.now()
  if (now >= lastCheckedAt && now - lastCheckedAt < SHARE_MS) return
  lastCheckedAt = now
  const [since, m, s, planNow, learned, list] = await Promise.all([
    read($, busySince),
    read($, main),
    read($, summary),
    read($, plan),
    read($, typical),
    read($, runs),
  ])
  // Agents still running after the turn ended keep the session working, at
  // their mean percent.
  const running = list.filter(r => r.kind === 'agent' && r.status === 'running')
  const isAgentsOnly = since === null && running.length > 0
  const state: Peer['state'] =
    since !== null
      ? m.mood === 'ask' ? 'waiting' : 'working'
      : isAgentsOnly ? 'working' : s === null || s.isAborted ? 'idle' : s.isFailed ? 'failed' : 'done'
  const agentsPercent = Math.round(running.reduce((sum, r) => sum + percent(r, learned, now), 0) / Math.max(1, running.length))
  const mine: Peer = {
    id: me.id,
    cwd: me.cwd,
    task: me.task,
    state,
    activity: isAgentsOnly ? `${plural(running.length, 'agent')} working` : state === 'working' ? m.activity : '',
    percent: isAgentsOnly ? agentsPercent : state === 'done' ? 100 : mainPercent(planNow, learned, since, now),
    updatedAt: now,
  }
  const shape = JSON.stringify({ ...mine, updatedAt: 0 })
  if (shape !== lastShared || now - lastSharedAt >= HEARTBEAT_MS || now < lastSharedAt) {
    await $.store.set(`${PEER_PREFIX}${me.id}`, mine)
    lastShared = shape
    lastSharedAt = now
  }

  const found: Peer[] = []
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PEER_PREFIX) || key === `${PEER_PREFIX}${me.id}`) continue
    const peer = toPeer(await $.store.get(key).catch(() => undefined))
    if (peer === undefined || now - peer.updatedAt > PEER_FORGET_MS) {
      await $.store.delete(key).catch(() => {})
      continue
    }
    if (now - peer.updatedAt <= PEER_STALE_MS && sameProject(peer.cwd, me.cwd)) found.push(peer)
  }
  // Sessions that need the person or are working come first, so they are
  // never the ones folded into "+N more".
  const rank: Record<Peer['state'], number> = { waiting: 0, working: 1, failed: 2, done: 3, idle: 4 }
  found.sort((a, b) => rank[a.state] - rank[b.state] || a.id.localeCompare(b.id))
  const before = await read($, peers)
  const seen = (l: readonly Peer[]) => JSON.stringify(l.map(p => ({ ...p, updatedAt: 0 })))
  if (seen(before) !== seen(found)) await update($, peers, () => found)

  // The week's tokens move with every session's turns: follow the store.
  const week = await savedWeek($, now)
  const weekTokens = week?.tokens ?? 0
  if ((await read($, usage)).weekTokens !== weekTokens) await update($, usage, u => ({ ...u, weekTokens }))
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

    // Who this session is, for the other sessions' Sessions lists. Its
    // project is its git repository's main root (the same for every worktree),
    // else its folder.
    const sessionId = await $.session.id().catch(() => undefined)
    const repo = await $.session.repo().catch(() => null)
    const project = repo?.root ?? e.cwd
    if (sessionId) await update($, self, old => ({ id: sessionId, cwd: project, task: old?.task ?? '' }))

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
        // Swap statuses with the other sessions in this project, checked about
        // once a second (it shares at most every SHARE_MS).
        if (tick % POLL_EVERY === 1) await shareStatus($).catch(() => {})
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
  // Background-task notices, other sessions' messages and other engine-queued
  // turns come through here too; they are not a new task, so they clear
  // nothing (an agent's row stays at 100%) and don't rename the session.
  on('prompt.submit', async ($, e, next) => {
    // A plugin's prompt counts when it carries the person's own words (`asUser`).
    const origin = e.origin as { kind?: string; asUser?: true } | undefined
    const isPerson = PERSON_ORIGINS.has(origin?.kind ?? 'composer') || (origin?.kind === 'plugin' && origin.asUser === true)
    if (e.isMeta || !isPerson) return next(e)
    await update($, runs, list => list.filter(r => r.status === 'running'))
    const live = new Set((await read($, runs)).map(r => r.id))
    await update($, expanded, ids => ids.filter(id => live.has(id)))
    await update($, plan, () => [])
    await update($, autoSteps, () => [])
    await update($, feed, () => [])
    await update($, feedCount, () => 0)
    await update($, files, () => [])
    await update($, summary, () => null)
    // The other sessions list this one by what the person asked it last.
    const task = clip(plainOf(e.text).trim(), TASK_MAX)
    if (task !== '') await update($, self, me => (me === null ? me : { ...me, task }))
    return next(e)
    // The tracker only observes: if its bookkeeping fails, the prompt still goes.
  }).catch(($, e, next) => next(e))

  // A session that ends takes itself off the other sessions' lists. After
  // /clear the process goes on as a new session with no session.start, so
  // what the old one did is cleared here and the new id is looked up again.
  on('session.end', async ($, e, next) => {
    // Unset first, so the ticker never publishes the ended session again.
    const me = await read($, self)
    await update($, self, () => null)
    if (me !== null) await $.store.delete(`${PEER_PREFIX}${me.id}`).catch(() => {})
    await update($, runs, () => [])
    await update($, expanded, () => [])
    await update($, plan, () => [])
    await update($, autoSteps, () => [])
    await update($, feed, () => [])
    await update($, feedCount, () => 0)
    await update($, files, () => [])
    await update($, summary, () => null)
    await update($, busySince, () => null)
    await update($, main, () => IDLE_MAIN)
    await update($, usage, u => ({ ...u, sessionTokens: 0, usd: undefined }))
    const out = await next(e)
    // A new id means the process goes on as a new session (/clear): it reports
    // again under that id. Guarded: a throw here would reach the .catch, which
    // ends the session again.
    await $.session
      .id()
      .then(id => (me !== null && id && id !== me.id ? update($, self, () => ({ ...me, id, task: '' })) : undefined))
      .catch(() => {})
    return out
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
        // A tool about to run reads as what it will do (`Reading…`), before its target is known.
        const activity = c.kind === 'tool' ? `${doingTitle(c.name, '')}…` : kind === 'text' ? 'writing reply…' : 'thinking…'
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
      await finishAuto($, isFailed).catch(() => {})
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
      name: plainOf(e.skill) || 'skill',
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

  // Skills the person runs as /name, or that load another way: the engine
  // expands their prompt. One the Skill tool loads already has its row.
  on('skill.prompt', async ($, e, next) => {
    const name = plainOf(e.skill) || 'skill'
    const isListed = (await read($, runs)).some(r => r.kind === 'skill' && r.status === 'running' && r.name === name)
    if (!isListed) {
      const now = await $.clock.now()
      await add($, { id: `skill-${name}-${now}`, kind: 'skill', name, detail: '', status: 'running', startedAt: now })
    }
    return next(e)
    // The tracker only observes: if its bookkeeping fails, the skill still loads.
  }).catch(($, e, next) => next(e))

  // Agents: recorded as the spawn starts; the ticker keeps their status. A
  // resumed agent (a follow-up message) is its own row again, running. Each
  // agent of a workflow run shares the Workflow call's id, so its place in
  // the run tells the rows apart.
  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    const resumed = e.resume?.agentId
    if (resumed && (await read($, runs)).some(r => r.kind === 'agent' && r.agentId === resumed)) {
      // Timed from the resume, not across the idle time before it. A follow-up
      // is not a whole run, so it teaches no typical time.
      await patch($, r => r.kind === 'agent' && r.agentId === resumed, {
        status: 'running',
        startedAt: now,
        endedAt: undefined,
        isLearned: true,
      })
      return next(e)
    }
    const base = e.workflow ? `${e.tool_use_id}:${e.workflow.runId}:${e.workflow.agentIndex}` : e.tool_use_id
    const taken = new Set((await read($, runs)).map(r => r.id))
    let id = base
    for (let k = 2; taken.has(id); k++) id = `${base}#${k}`
    await update($, runs, list => {
      const run: Run = {
        id,
        kind: 'agent',
        name: plainOf(e.subagentType) || 'agent',
        detail: plainOf(e.description),
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
    const [mainNow, feedNow, feedTotal, filesNow, summaryNow, usageNow, peersNow] = await Promise.all([
      read($, main),
      read($, feed),
      read($, feedCount),
      read($, files),
      read($, summary),
      read($, usage),
      read($, peers),
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
    // Sessions: heading, a line per session (two while it works), a count of
    // the ones not shown, and a spacer.
    const peersShown = peersNow.slice(0, SHOWN_PEERS)
    const hiddenPeers = peersNow.length - peersShown.length
    const peerLines = (p: Peer) => (p.state === 'working' && p.activity !== '' ? 2 : 1)
    const sessionsRows =
      peersShown.length > 0 ? 2 + peersShown.reduce((k, p) => k + peerLines(p), 0) + (hiddenPeers > 0 ? 1 : 0) : 0
    const room = Math.max(
      3,
      bodyRows -
        8 -
        (since !== null ? 3 : 0) -
        planRows -
        usageRows -
        feedRows -
        filesRows -
        summaryRows -
        sessionsRows,
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
      const time = clock((r.endedAt ?? now) - r.startedAt)
      const tools = plural(r.tools ?? 0, 'tool')
      // The bar takes what the line leaves after indent, percent, time and tools.
      const width = Math.max(RUNNER[0]!.length + 3, Math.min(barWidth, columns - 9 - `  ${time} · ${tools}`.length))
      const track = width - RUNNER[0]!.length
      const filled = Math.round((pct / 100) * track)
      // Offset each agent's blink by its color slot so they don't blink in sync.
      const isBlink = (n + (r.hue ?? 0) * 5) % BLINK_EVERY === BLINK_EVERY - 1
      const runner =
        r.status === 'running'
          ? isBlink ? RUNNER_BLINK : RUNNER[n % RUNNER.length]
          : r.status === 'done' ? RUNNER_DONE : RUNNER_FAILED
      const isOpen = open.includes(r.id)
      // A Button cannot truncate, so cut the type and the task to fit, by columns.
      const name = clip(r.name, columns - 5)
      const detailRoom = columns - 7 - textWidth(name)
      const detail = detailRoom >= 4 ? clip(r.detail ?? '', detailRoom) : ''
      const toggle = () =>
        update($, expanded, ids => (ids.includes(r.id) ? ids.filter(id => id !== r.id) : [...ids, r.id]))
      const calls = (r.calls ?? []).slice(-SHOWN_CALLS)
      return (
        <Box flexDirection="column">
          <Button key={`agent-${r.id}`} plain onPress={toggle}>
            {isOpen ? '▾ ' : '▸ '}
            <Text color={r.status === 'running' ? color : colorOf(r)}>{`${glyphOf(r)} `}</Text>
            {name}
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
                {` ${shortTool(c.tool).padEnd(6)} ${c.target}`}
                <Text dimColor>{c.endedAt === undefined ? '' : `  ${short(c.endedAt - c.startedAt)}`}</Text>
              </Text>
            ))}
        </Box>
      )
    }

    // Skill: status, name (cut so its time still shows) and time.
    const skillRow = (r: Run) => {
      const time = clock((r.endedAt ?? now) - r.startedAt)
      return (
        <Text
          wrap="truncate-end"
          dimColor={r.status === 'done'}
          color={r.status === 'failed' ? 'error' : r.status === 'running' ? ORANGE : undefined}
        >
          {` ${glyphOf(r)} ${clip(r.name, Math.max(8, columns - 5 - time.length))}  ${time}`}
        </Text>
      )
    }

    // Claude: the turn's progress, with a mini Clawd running at the head and
    // what Claude is doing right now beneath.
    const mainPct = mainPercent(planNow, learned, since, now)
    const mainWidth = Math.max(14, Math.min(40, columns - 28))

    // Plan: each step's title gets the whole line, so it reads in a narrow
    // pane: ✓ done, ○ pending. The active step has its bar on a line of its
    // own beneath, filling by time with the mini Clawd running at its head.
    const titleWidth = Math.max(8, columns - 4)
    const stepWidth = Math.max(RUNNER[0]!.length + 3, Math.min(28, columns - 18))
    const stepRow = (s: PlanStep) => {
      // A merged step's ×N stays when its title is cut.
      const times = s.count !== undefined && s.count > 1 ? ` ×${s.count}` : ''
      const title = `${clip(s.title, titleWidth - times.length)}${times}`
      const isActive = s.status === 'active'
      const isFailed = s.status === 'done' && s.isFailed === true
      const head = (
        <Text wrap="truncate-end">
          {'  '}
          <Text
            color={isFailed ? 'error' : s.status === 'done' ? 'success' : isActive ? HOT : undefined}
            dimColor={s.status === 'pending'}
          >
            {isFailed ? '✗' : s.status === 'done' ? '✓' : isActive ? SPIN[n % SPIN.length] : '○'}
          </Text>
          <Text dimColor={!isActive}>{` ${title}`}</Text>
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
    // The bars share one width: what the longest reset time leaves of the line.
    const resetText = (l: Limit) => {
      const left = l.resetsAt === undefined ? NaN : Date.parse(l.resetsAt) - now
      return Number.isNaN(left) ? '' : `  resets in ${until(left)}`
    }
    const longestReset = Math.max(0, ...usageNow.limits.map(l => resetText(l).length))
    const limitWidth = Math.max(6, Math.min(24, columns - 15 - longestReset))
    const limitRow = (l: Limit) => {
      const pct = Math.round(l.percentUsed)
      const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * limitWidth)
      const color = pct >= ALERT_AT ? 'error' : pct >= WARN_AT ? 'warning' : 'success'
      const name = (LIMIT_NAMES[l.kind] ?? l.kind).slice(0, 8).padEnd(8)
      return (
        <Text wrap="truncate-end">
          <Text bold>{` ${name} `}</Text>
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text dimColor>{'─'.repeat(limitWidth - filled)}</Text>
          <Text color={pct >= WARN_AT ? color : undefined}>{` ${String(pct).padStart(3)}%`}</Text>
          <Text dimColor>{resetText(l)}</Text>
        </Text>
      )
    }
    // Tokens: in the longest words that fit beside the cost, so it shows.
    const cost = usageNow.usd === undefined ? '' : ` · $${usageNow.usd.toFixed(2)}`
    const [sessionText, weekText] = [tokens(usageNow.sessionTokens), tokens(usageNow.weekTokens)]
    const tokenForms = [
      `${sessionText} session · ${weekText} week`,
      `${sessionText} sess · ${weekText} wk`,
      `${sessionText} · ${weekText} wk`,
    ]
    const tokensText = tokenForms.find(f => 10 + f.length + cost.length <= columns) ?? tokenForms.at(-1)!
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
          {tokensText}
          <Text dimColor>{cost}</Text>
        </Text>
        <Text> </Text>
      </Box>
    )

    // Recent: the main loop's newest calls under a declared plan, each with
    // its kind's icon (✗ once failed), what it did and how long it took.
    const feedTitleWidth = Math.max(8, columns - 12)
    const feedRow = (f: FeedItem) => {
      const title = padTo(clip(f.title, feedTitleWidth), feedTitleWidth)
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
      const width = textWidth(f.name) + 4
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
    // What fits goes in: failed calls always first, then the files and tools
    // in the longest words that fit together (`2 files edited` or `2 edited`),
    // else as many of them as fit; they show in reading order.
    const doneParts = (() => {
      if (!summaryNow) return { files: '', tools: '', failed: '' }
      const part = (s: string) => (s === '' ? '' : ` · ${s}`)
      let room = columns - ending.word.length - ending.mark.length - clock(summaryNow.durationMs).length
      const failed = summaryNow.failed > 0 && part(`${summaryNow.failed} failed`).length <= room
        ? part(`${summaryNow.failed} failed`)
        : ''
      room -= failed.length
      const [many, word] = edited.length > 0 ? [edited.length, 'edited'] : [readOnly.length, 'read']
      const fileForms = many > 0 ? [part(`${plural(many, 'file')} ${word}`), part(`${many} ${word}`)] : ['']
      const tools = part(plural(summaryNow.tools, 'tool'))
      const choices = [
        ...fileForms.map(files => ({ files, tools })),
        ...fileForms.map(files => ({ files, tools: '' })),
        { files: '', tools },
      ]
      const pick = choices.find(c => c.files.length + c.tools.length <= room) ?? { files: '', tools: '' }
      return { ...pick, failed }
    })()
    const summaryRow = summaryNow && (
      <Text wrap="truncate-end">
        <Text bold>{ending.word}</Text>
        <Text color={ending.color}>{ending.mark}</Text>
        {clock(summaryNow.durationMs)}
        <Text dimColor>{`${doneParts.files}${doneParts.tools}`}</Text>
        <Text color="error">{doneParts.failed}</Text>
      </Text>
    )

    // Sessions: the other sessions in this project, each with what it was
    // asked, its state and percent, and what it is doing while it works.
    const PEER_LOOK: Record<Peer['state'], { mark: string; color?: string }> = {
      working: { mark: SPIN[n % SPIN.length]!, color: HOT },
      waiting: { mark: '?', color: 'warning' },
      done: { mark: '✓', color: 'success' },
      failed: { mark: '✗', color: 'error' },
      idle: { mark: '○' },
    }
    const peerRow = (p: Peer) => {
      const pct = ` ${String(p.percent).padStart(3)}%`
      const isLive = p.state === 'working' || p.state === 'waiting'
      const taskRoom = Math.max(8, columns - 4 - (isLive ? pct.length : 0))
      const task = clip(p.task || 'new session', taskRoom)
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            {'  '}
            <Text color={PEER_LOOK[p.state].color} dimColor={p.state === 'idle'}>
              {PEER_LOOK[p.state].mark}
            </Text>
            <Text dimColor={!isLive}>{` ${isLive ? padTo(task, taskRoom) : task}`}</Text>
            {isLive && <Text color={PEER_LOOK[p.state].color}>{pct}</Text>}
          </Text>
          {peerLines(p) === 2 && (
            <Text wrap="truncate-end" dimColor>
              {`    ${clip(p.activity, Math.max(4, columns - 4))}`}
            </Text>
          )}
        </Box>
      )
    }
    const peersWorking = peersNow.filter(p => p.state === 'working' || p.state === 'waiting').length
    // The rest by what they came to: "· 1 failed · 2 done · 1 idle", those there are.
    const sessionCounts = (['failed', 'done', 'idle'] as const)
      .map(state => [state, peersNow.filter(p => p.state === state).length] as const)
      .filter(([, k]) => k > 0)
      .map(([state, k]) => ` · ${k} ${state}`)
      .join('')
    const sessionsRowsShown = (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>Sessions</Text>
          <Text dimColor>{`   ${peersWorking} working${sessionCounts}`}</Text>
        </Text>
        {peersShown.map(peerRow)}
        {hiddenPeers > 0 && <Text dimColor>{` +${hiddenPeers} more`}</Text>}
        <Text> </Text>
      </Box>
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
        {peersShown.length > 0 && sessionsRowsShown}
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
          // The newest that fit; a last line counts the older ones that do not.
          skills.slice(-(skills.length > skillRoom ? Math.max(1, skillRoom - 1) : skillRoom)).map(skillRow)
        )}
        {skills.length > skillRoom && (
          <Text dimColor>{` +${skills.length - Math.max(1, skillRoom - 1)} more`}</Text>
        )}
      </Box>
    )
  })
}
