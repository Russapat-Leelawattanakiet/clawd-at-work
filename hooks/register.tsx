import { atom, read, update } from 'claude-code'
import type { AgentInfo, AgentStatus, EngineInterface, ModelUsage, Register, SessionCost } from 'claude-code'

import type {
  Call,
  ContextDetail,
  ContextFill,
  ContextPiece,
  FeedItem,
  Limit,
  MainTurn,
  Mood,
  Peer,
  PlanStep,
  RemoteAgent,
  RemoteSession,
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
// Fully saturated so each bar pops: cyan, violet, green, pink, blue, yellow.
// No orange: that is the default Claude bar's and steps' color (HOT). An agent
// never takes its own session's color either (nextHue), so no agent can be
// mistaken for the main loop.
const PALETTE = ['#00C8FF', '#9B4DFF', '#00E676', '#FF2E9A', '#3D6BFF', '#FFD400']
// The Claude bar and plan steps by default: a hot Claude orange in the same saturation.
const HOT = '#FF6B1A'
// Session colors: each session has one, for its Claude bar, its steps and
// its line in the other sessions' panes. The person picks one with
// `/clawd-at-work color <name>`; otherwise the first one no other session
// has. A session's own agents never take its color (see nextHue).
const SESSION_COLORS: readonly { name: string; hex: string }[] = [
  { name: 'orange', hex: HOT },
  { name: 'blue', hex: '#3D6BFF' },
  { name: 'green', hex: '#00E676' },
  { name: 'pink', hex: '#FF2E9A' },
  { name: 'cyan', hex: '#00C8FF' },
  { name: 'purple', hex: '#9B4DFF' },
  { name: 'yellow', hex: '#FFD400' },
  { name: 'red', hex: '#FF3B3B' },
  { name: 'teal', hex: '#1DE9B6' },
  { name: 'lime', hex: '#C6FF00' },
]
const isColorName = (name: unknown): name is string =>
  typeof name === 'string' && SESSION_COLORS.some(c => c.name === name)
// A color name's hex; an unknown or missing one reads as orange.
const hexOf = (name: string | undefined) => SESSION_COLORS.find(c => c.name === name)?.hex ?? HOT
// The agent palette slot a session color is, or -1: that session's agents skip it.
const slotOf = (name: string | undefined) => PALETTE.indexOf(hexOf(name))

// Sounds, from the mod's own sounds/ folder: `attention` when this session
// waits for the person (a permission prompt, a question, a plan to approve),
// `done` when a turn of at least DONE_SOUND_MIN_MS ends. One kind does not
// sound again within SOUND_COOLDOWN_MS (a question sounds as its call starts,
// and its session record says waiting a scan later: one sound). On or off for every session with
// `/clawd-at-work sound on|off`, kept in the store.
const SOUND_KEY = 'sound-on'
const DONE_SOUND_MIN_MS = 10_000
const SOUND_COOLDOWN_MS = 4_000
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
// A shell call's own description, when no template names it; the pane cuts it
// to its width.
const DESCRIPTION_MAX = 60

const MAX_STEPS = 20
// Plan titles are kept up to this long; the pane cuts them to its width.
const STEP_MAX = 200
// Steps or plan steps shown while the list is open; pressing its heading
// folds them away and back.
const SHOWN_STEPS = 6

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
// An agent row the engine's list never named (a workflow's) and that has done
// nothing this long, with no call under way, is taken as ended: its turn's end
// was missed (a reload, a stalled attempt the workflow retried).
const AGENT_QUIET_MS = 15 * 60_000
// A spawn that has not answered its agent's id this long never will.
const SPAWN_PENDING_MS = 30_000
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
const remote = atom({ plugin: 'clawd-at-work', key: 'remote' } as const, [])
const remoteError = atom({ plugin: 'clawd-at-work', key: 'remoteError' } as const, null)
const context = atom({ plugin: 'clawd-at-work', key: 'context' } as const, null)
const contextOpen = atom({ plugin: 'clawd-at-work', key: 'contextOpen' } as const, false)
const stepsFolded = atom({ plugin: 'clawd-at-work', key: 'stepsFolded' } as const, false)
const agentsFolded = atom({ plugin: 'clawd-at-work', key: 'agentsFolded' } as const, false)
const contextDetail = atom({ plugin: 'clawd-at-work', key: 'contextDetail' } as const, null)
const sessionColor = atom({ plugin: 'clawd-at-work', key: 'color' } as const, null)
// Pieces named on one line of the Context dropdown (MCP servers, memory files).
const SHOWN_PIECES = 3

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

// `text` cut from the front to at most `width` columns, starting with … when
// cut: for names that share a long prefix and differ at the end.
const clipStart = (text: string, width: number) => {
  if (textWidth(text) <= width) return text
  let out = ''
  let used = 0
  for (const g of glyphs(text).reverse()) {
    if (used + g.width > width - 1) break
    out = g.text + out
    used += g.width
  }
  return `…${out}`
}

// A palette slot that stays the same for an id from draw to draw.
const hueOf = (id: string) => [...id].reduce((h, ch) => (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0, 7)

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

// A shell command split into the commands it chains (&&, ||, ;, new lines).
// Quotes, brackets and heredoc bodies are not split, and only the first
// command of a pipe counts: in `grep x | head`, the work is the grep.
const shellParts = (command: string) => {
  const parts: string[] = []
  let part = ''
  let quote = ''
  let depth = 0
  let isPiped = false
  let heredoc = ''
  const close = () => {
    parts.push(part.trim())
    part = ''
    isPiped = false
  }
  const add = (text: string) => {
    if (!isPiped) part += text
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    if (quote !== '') {
      if (c === '\\' && quote === '"' && command[i + 1] === '"') {
        add('\\"')
        i++
        continue
      }
      if (c === quote) quote = ''
      add(c)
      continue
    }
    if (c === '\\' && /[\r\n]/.test(command[i + 1] ?? '')) {
      add(' ')
      i += command[i + 1] === '\r' && command[i + 2] === '\n' ? 2 : 1
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      add(c)
      continue
    }
    const here = c === '<' ? /^<<-?\s*["']?(\w+)["']?/.exec(command.slice(i, i + 80)) : null
    if (here) {
      heredoc = here[1]!
      i += here[0].length - 1
      continue
    }
    if (c === '(' || c === '{') depth++
    if ((c === ')' || c === '}') && depth > 0) depth--
    const isNewLine = c === '\n' || c === '\r'
    if (isNewLine && heredoc !== '') {
      // Skip the heredoc's body, up to and including the line that ends it.
      let at = i
      while (at !== -1 && at < command.length) {
        const next = command.indexOf('\n', at + 1)
        const line = command.slice(at + 1, next === -1 ? command.length : next)
        at = next
        if (line.trim() === heredoc) break
      }
      heredoc = ''
      if (at === -1) break
      i = at
      if (depth === 0) close()
      continue
    }
    if (depth > 0) {
      add(isNewLine ? ' ' : c)
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === '&&' || pair === '||') {
      close()
      i++
    } else if (c === ';' || isNewLine) {
      close()
    } else if (c === '|') {
      isPiped = true
    } else {
      add(c)
    }
  }
  close()
  return parts.filter(p => p !== '')
}

// Words in front of a command that say nothing of its work.
const SHELL_PREFIX =
  /^(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+|(?:sudo|time|nohup|command|exec|do|then|else|elif|if|while|until)\s+|[!&]\s+|timeout\s+\S+\s+)/i
// Commands that are plumbing: left out when a chain has anything else to show.
const SHELL_NOISE =
  /^(?:(?:cd|chdir|pushd|popd|set-location|sl|echo|printf|write-host|write-output|true|false|:|pwd|set|exit|export|clear|sleep|for|foreach|case|function|done|fi|esac|\{|\}|\(|\))(?:\s|$)|[A-Za-z_]\w*=|\$\w+\s*=)/i
const SHELL_ARG = `("[^"]*"|'[^']*'|[^\\s"'-][^\\s"']*)`

// Plain words for common commands, the most telling first: a chain is named
// after the first row any of its commands matches. $1 is the row's capture,
// cut to a file name, or a host for a URL.
const SHELL_TEMPLATES: [RegExp, string, string][] = [
  [/^git push\b/i, 'Push changes', 'Pushing changes'],
  [/^git commit\b/i, 'Commit changes', 'Committing changes'],
  [/^git merge\b/i, 'Merge branch', 'Merging branch'],
  [/^git rebase\b/i, 'Rebase branch', 'Rebasing branch'],
  [/^git pull\b/i, 'Pull changes', 'Pulling changes'],
  [/^git clone\b/i, 'Clone repository', 'Cloning repository'],
  [/^gh pr create\b/i, 'Open pull request', 'Opening pull request'],
  [/^gh pr\b/i, 'Check pull request', 'Checking pull request'],
  [/^gh issue\b/i, 'Check GitHub issue', 'Checking GitHub issue'],
  [/^gh\b/i, 'Use GitHub', 'Using GitHub'],
  [
    /^(?:(?:npm|pnpm|yarn|bun)(?: run)? test\b|npx (?:vitest|jest|playwright)\b|vitest\b|jest\b|pytest\b|python[\d.]* -m pytest\b|cargo test\b|go test\b|make (?:test|check)\b|claude plugin test\b)/i,
    'Run tests',
    'Running tests',
  ],
  [/^(?:(?:npm|pnpm|yarn|bun)(?: run)? build\b|(?:npx )?vite build\b|cargo build\b|go build\b|make\b)/i, 'Build project', 'Building project'],
  [/^(?:npx )?tsc\b/i, 'Check types', 'Checking types'],
  [/^(?:(?:npm|pnpm|yarn|bun)(?: run)? lint\b|(?:npx )?eslint\b|ruff\b)/i, 'Check code style', 'Checking code style'],
  [/^(?:npx )?prettier\b/i, 'Format code', 'Formatting code'],
  [/^(?:(?:npm|pnpm|yarn|bun) (?:install|i|ci|add)\b|pip[\d.]* install\b|uv (?:pip|add)\b|cargo add\b)/i, 'Install packages', 'Installing packages'],
  [/^(?:npm|pnpm|yarn|bun) (?:uninstall|remove|rm)\b/i, 'Remove packages', 'Removing packages'],
  [/^claude plugin validate\b/i, 'Validate plugin', 'Validating plugin'],
  [/^claude plugin (?:install|update)\b/i, 'Install plugin', 'Installing plugin'],
  [/^claude plugin uninstall\b/i, 'Uninstall plugin', 'Uninstalling plugin'],
  [/^claude plugin\b/i, 'Manage plugins', 'Managing plugins'],
  [/^(?:rm|rmdir|del|remove-item)\b/i, 'Delete files', 'Deleting files'],
  [/^(?:mv|move|ren|move-item|rename-item)\b/i, 'Move files', 'Moving files'],
  [/^(?:cp|copy|copy-item)\b/i, 'Copy files', 'Copying files'],
  [/^(?:mkdir|md)\b/i, 'Create folder', 'Creating folder'],
  [/^new-item\b/i, 'Create item', 'Creating item'],
  [/^write-to (.+)$/i, 'Write $1', 'Writing $1'],
  [/^sed\b.*\s-i\b/i, 'Edit file', 'Editing file'],
  [/^git add\b/i, 'Stage files', 'Staging files'],
  [/^git (?:switch|checkout)\b/i, 'Switch branch', 'Switching branch'],
  [/^git stash\b/i, 'Stash changes', 'Stashing changes'],
  [/^git (?:restore|reset)\b/i, 'Undo changes', 'Undoing changes'],
  [/^git fetch\b/i, 'Fetch changes', 'Fetching changes'],
  [/^git diff\b/i, 'Compare changes', 'Comparing changes'],
  [/^git show\b/i, 'Show commit', 'Showing commit'],
  [/^git log\b/i, 'Read git history', 'Reading git history'],
  [/^git status\b/i, 'Check git status', 'Checking git status'],
  [/^git branch\b/i, 'Check branches', 'Checking branches'],
  [/^git remote\b/i, 'Check remotes', 'Checking remotes'],
  [/^git (\S+)/i, 'Run git $1', 'Running git $1'],
  [/^(?:python[\d.]*|py|node|deno|ruby|perl)\s+(?:-\S+\s+)*-[cep]\b/i, 'Run inline code', 'Running inline code'],
  [new RegExp(`^(?:python[\\d.]*|py|node|deno|ruby|tsx|ts-node)\\s+(?:-\\S+\\s+)*${SHELL_ARG}`, 'i'), 'Run $1', 'Running $1'],
  [/^(\S+\.(?:sh|bash|ps1|py|js|mjs|ts))(?:\s|$)/i, 'Run $1', 'Running $1'],
  [/^(?:npm|pnpm|yarn|bun) run (\S+)/i, 'Run $1 script', 'Running $1 script'],
  [/^npx (?:-\S+\s+)*([^\s-]\S*)/i, 'Run $1', 'Running $1'],
  [/^(?:curl|wget|invoke-webrequest|iwr)\b.*?(https?:\/\/[^\s"']+)/i, 'Download from $1', 'Downloading from $1'],
  [/^(?:curl|wget|invoke-webrequest|iwr)\b/i, 'Download file', 'Downloading file'],
  [new RegExp(`^(?:cat|head|tail|type|less|more|get-content|gc)\\b(?:.*\\s)?${SHELL_ARG}$`, 'i'), 'Read $1', 'Reading $1'],
  [/^(?:cat|head|tail|type|less|more|get-content|gc|sed)\b/i, 'Read file', 'Reading file'],
  [/^(?:grep|rg|ag|ack|findstr|select-string|sls)\b/i, 'Search files', 'Searching files'],
  [/^(?:ls|ll|dir|find|fd|tree|gci|get-childitem)\b/i, 'List files', 'Listing files'],
  [/^wc\b/i, 'Count lines', 'Counting lines'],
  [/^(?:awk|perl|sort|uniq|jq|cut|tr|xargs)\b/i, 'Process text', 'Processing text'],
  [/^sleep\b/i, 'Wait', 'Waiting'],
]

type Words = { action: string; doing: string }

// A command with its prefixes gone, ready to match: its program in lower case
// with no folder or .exe, redirects dropped, `cat > x` read as a write, and
// `git -C folder` read as plain git.
const shellMatchText = (text: string) => {
  const write = /^(?:cat|echo|printf)\b.*?(?<!\d)>{1,2}\s*("[^"]*"|'[^']*'|[^\s"'&]+)\s*$/i.exec(text)?.[1]
  if (write !== undefined && !/^["']?(?:\/dev\/null|nul)["']?$/i.test(write)) return `write-to ${write}`
  const plain = text.replace(/\s*\d*(?:>>?|<<<?-?)&?\s*(?:"[^"]*"|'[^']*'|[^\s"']+)/g, '')
  const m = /^("[^"]*"|'[^']*'|\S+)\s*([\s\S]*)$/.exec(plain)
  if (!m) return plain
  const program = baseName(m[1]!.replace(/^["']|["']$/g, ''))
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat)$/, '')
  const rest = program === 'git' ? m[2]!.replace(/^(?:-[cC]\s+(?:"[^"]*"|'[^']*'|\S+)\s+)+/, '') : m[2]!
  return `${program} ${rest}`.trim()
}

// What a template's $1 shows: a URL's host, else a file or folder name.
const templateName = (value: string) => {
  const text = plainLine(value.replace(/^["']|["']$/g, ''))
  const host = /^[a-z][a-z\d+.-]*:\/\/(?:www\.)?([^/?#:]+)/i.exec(text)?.[1]
  return clip(host ?? baseName(text), 30)
}

// A shell call in plain words: a template when any of its commands has one,
// with `+N` for the others; else the description Claude already gave the
// call, which costs no tokens to read. Undefined when it has neither.
const shellWords = (command: unknown, description: unknown): Words | undefined => {
  if (typeof command !== 'string') return undefined
  const texts = shellParts(command).map(part => {
    let text = part
    for (let m = SHELL_PREFIX.exec(text); m; m = SHELL_PREFIX.exec(text)) text = text.slice(m[0].length)
    return text.trim()
  })
  const work = texts.filter(t => t !== '' && !SHELL_NOISE.test(t))
  const parts = (work.length > 0 ? work : texts.filter(t => t !== '')).map(shellMatchText)
  const more = parts.length > 1 ? ` +${parts.length - 1}` : ''
  for (const [pattern, action, doing] of SHELL_TEMPLATES) {
    for (const part of parts) {
      const m = pattern.exec(part)
      if (!m) continue
      const fill = (words: string) => `${words.replace('$1', m[1] ? templateName(m[1]) : '')}${more}`
      return { action: fill(action), doing: fill(doing) }
    }
  }
  const said = plainOf(description).trim()
  if (said === '') return undefined
  return { action: clip(said, DESCRIPTION_MAX), doing: clip(said, DESCRIPTION_MAX) }
}

// A Grep pattern a person can read: the longest plain word of its first
// alternative, with `+N` for the others (`a|b|c` reads `a +2`).
const searchTarget = (pattern: string) => {
  if (!/[|\\()[\]^$+?*{}]/.test(pattern)) return pattern
  const alternatives: string[] = ['']
  let depth = 0
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!
    if (c === '\\' && pattern[i + 1] !== '|') {
      alternatives[alternatives.length - 1] += pattern.slice(i, i + 2)
      i++
      continue
    }
    if (c === '(' || c === '[') depth++
    if ((c === ')' || c === ']') && depth > 0) depth--
    const isEscapedBar = c === '\\' && pattern[i + 1] === '|'
    if (depth === 0 && (c === '|' || isEscapedBar)) {
      alternatives.push('')
      if (isEscapedBar) i++
      continue
    }
    alternatives[alternatives.length - 1] += c
  }
  const words = alternatives[0]!
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\\[a-zA-Z]/g, ' ')
    .match(/[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu)
  const word = (words ?? []).reduce((best, w) => (w.length > best.length ? w : best), '')
  if (word === '') return 'a pattern'
  return alternatives.length > 1 ? `${word} +${alternatives.length - 1}` : word
}

// What a tool call works on: the first naming field of its input in plain
// words (a template for a shell command, a host for a URL, a readable word for
// a search), one plain line of at most TARGET_MAX columns.
const targetOf = (input: Record<string, unknown>) => {
  for (const field of TARGET_FIELDS) {
    const value = input[field]
    if (typeof value !== 'string' || value === '') continue
    const named =
      field === 'command'
        ? (shellWords(value, input.description)?.action ?? shellTarget(value))
        : field === 'url'
          ? templateName(value)
          : field === 'pattern' && input.tool === 'Grep'
            ? searchTarget(value)
            : field.endsWith('path')
              ? baseName(value)
              : value
    const text = plainLine(named)
    if (text.trim() === '') continue
    return clip(text, TARGET_MAX)
  }
  return ''
}

// A name in plain lower-case words: searchJiraIssues, list_issues and
// read-design all read as words.
const spaced = (name: string) =>
  name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim()

// A tool's display name. An MCP tool reads `Google Drive: search files`, not
// mcp__claude_ai_Google_Drive__search_files; another tool Claude has that the
// table below does not name reads in plain words too (`Some unknown tool`).
const toolName = (name: string) => {
  if (!name.startsWith('mcp__')) {
    const words = spaced(name)
    return words === '' ? name : `${words[0]!.toUpperCase()}${words.slice(1)}`
  }
  const [server = '', ...rest] = name.split('__').slice(1)
  const label = server
    .replace(/^claude_ai_/, '')
    .replace(/^plugin_[^_]+_/, '')
    .replace(/_/g, ' ')
  const tool = spaced(rest.join(' '))
  const own = tool.toLowerCase().startsWith(`${label.toLowerCase()} `) ? tool.slice(label.length + 1) : tool
  return own === '' ? label : `${label}: ${own}`
}

// The same, short, for a dropdown line: an MCP tool by its own name alone
// (`list issues`), so the target still fits.
const shortTool = (name: string) => (name.startsWith('mcp__') ? spaced(name.split('__').at(-1) ?? name) : name)

// Steps from a TodoWrite call: titles trimmed to one short line,
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
  EnterPlanMode: { action: 'Start planning', doing: 'Planning', mood: 'think' },
  SendMessage: { action: 'Message an agent', doing: 'Messaging an agent', mood: 'agent' },
  ListAgents: { action: 'List agents', doing: 'Listing agents', mood: 'agent' },
  TaskStop: { action: 'Stop a task', doing: 'Stopping a task', mood: 'agent' },
  Workflow: { action: 'Run workflow', doing: 'Running workflow', mood: 'agent' },
  Monitor: { action: 'Watch for a change', doing: 'Watching for a change', mood: 'tool' },
  ArtifactData: { action: 'Update page data', doing: 'Updating page data', mood: 'tool' },
  ArtifactComments: { action: 'Check page comments', doing: 'Checking page comments', mood: 'tool' },
  EnterWorktree: { action: 'Enter worktree', doing: 'Entering worktree', mood: 'tool' },
  ExitWorktree: { action: 'Leave worktree', doing: 'Leaving worktree', mood: 'tool' },
}
const withTarget = (words: string, target: string) => `${words}${target ? ` ${target}` : ''}`
const actionTitle = (tool: string, target: string) => withTarget(TOOLS[tool]?.action ?? toolName(tool), target)
const doingTitle = (tool: string, target: string) => withTarget(TOOLS[tool]?.doing ?? toolName(tool), target)
// A call's words for its step and feed row, and for the line under the Claude
// bar. A template already says what a shell call does, and an MCP tool's name
// fills the line, so neither takes a target.
const titlesOf = (tool: string, input: Record<string, unknown>): Words => {
  const words = tool === 'Bash' || tool === 'PowerShell' ? shellWords(input.command, input.description) : undefined
  if (words) return words
  if (tool.startsWith('mcp__')) return { action: toolName(tool), doing: toolName(tool) }
  const target = targetOf(input)
  return { action: actionTitle(tool, target), doing: doingTitle(tool, target) }
}
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

// The palette slots other sessions' agents hold now, set by each scan.
let remoteHues = new Set<number>()

// Next palette slot after the newest agent's, so neighbours never match,
// skipping the slots running agents (here or in other sessions) hold while
// a free one is left. The slot `avoid` (the session's own color) is never
// taken, so an agent is never mistaken for its session's Claude bar.
const nextHue = (list: readonly Run[], avoid = -1) => {
  const agents = list.filter(r => r.kind === 'agent')
  const last = agents.at(-1)
  let start = last?.hue === undefined ? 0 : (last.hue + 1) % PALETTE.length
  if (start === avoid) start = (start + 1) % PALETTE.length
  const taken = new Set(remoteHues)
  for (const r of agents) if (r.status === 'running' && r.hue !== undefined) taken.add(r.hue % PALETTE.length)
  for (let i = 0; i < PALETTE.length; i++) {
    const hue = (start + i) % PALETTE.length
    if (hue !== avoid && !taken.has(hue)) return hue
  }
  return start
}

// Agents whose run ended, by id, as their own turn.complete said. Kept beside
// the rows because that end can come before the spawn has answered the id.
// A turn start or a resume takes the agent off again.
const endedAgents = new Map<string, Run['status']>()

// Add a row for each running agent the engine lists that the pane has not
// seen: loops the engine starts with no `agent.spawn` (a forked skill, such as
// a review running in the background) arrive this way. Ones already finished
// are left out, so rows a prompt cleared never come back. While a spawn has not
// answered its agent's id yet, wait: that agent is the row being spawned.
const discoverAgents = async ($: EngineInterface, agents: readonly AgentInfo[], now: number) => {
  const list = await read($, runs)
  const isSpawning = (r: Run) =>
    r.kind === 'agent' && r.status === 'running' && r.agentId === undefined && now - r.startedAt < SPAWN_PENDING_MS
  if (list.some(isSpawning)) return
  const known = new Set(list.flatMap(r => (r.kind === 'agent' && r.agentId ? [r.agentId] : [])))
  // One whose turn already ended is not running, whatever a lagging list says.
  const fresh = agents.filter(a => !known.has(a.id) && !endedAgents.has(a.id) && toStatus(a.status) === 'running')
  if (fresh.length === 0) return
  const avoid = slotOf((await read($, sessionColor))?.name)
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
        hue: nextHue([...l, ...added], avoid),
        agentId: a.id,
      })
    }
    return [...l, ...added].slice(-MAX_RUNS)
  })
}

// When an agent row last did something. A call under way counts as activity
// for at most CALL_ACTIVE_MS: one whose end was never heard (cut, or its hook
// failed) must not keep the row running forever. A shell call's own limit is
// ten minutes.
const CALL_ACTIVE_MS = 15 * 60_000
const lastActiveOf = (r: Run) =>
  (r.calls ?? []).reduce((at, c) => Math.max(at, c.endedAt ?? c.startedAt + CALL_ACTIVE_MS), r.startedAt)

// End the running agent rows `pick` names, as `status`, at `now`. A first run
// that finished teaches its type's typical time, unless `isTimed` is false
// (an end found late, whose time says nothing).
const endRuns = async (
  $: EngineInterface,
  pick: (r: Run) => boolean,
  status: Run['status'],
  now: number,
  isTimed = true,
) => {
  const ending = (await read($, runs)).filter(r => r.kind === 'agent' && r.status === 'running' && pick(r))
  if (ending.length === 0) return
  const ids = new Set(ending.map(r => r.id))
  await update($, runs, l =>
    l.map(r =>
      ids.has(r.id) && r.status === 'running'
        ? { ...r, status, endedAt: now, ...(status === 'done' ? { isLearned: true } : {}) }
        : r,
    ),
  )
  if (status !== 'done' || !isTimed) return
  for (const r of ending) if (!r.isLearned) await learn($, r.name, now - r.startedAt).catch(() => {})
}

// Sync agent runs with what the engine reports, adding any it runs that the
// pane has not seen, and learn from the ones that just finished successfully.
// The list only ever ends a row: it can still say running after the agent's
// turn ended, so only a turn start or a resume runs a row again. A row the list
// no longer names has ended: listed once and dropped, or never listed (a
// workflow's) and quiet too long.
const pollAgents = async ($: EngineInterface) => {
  const agents = await $.agent.list()
  const byId = new Map(agents.map(a => [a.id, a]))
  const now = await $.clock.now()
  await discoverAgents($, agents, now)
  const list = await read($, runs)

  const listed = new Set<string>()
  const ends = new Map<Run['status'], Set<string>>()
  const endAs = (status: Run['status'], id: string) => {
    if (!ends.has(status)) ends.set(status, new Set())
    ends.get(status)!.add(id)
  }
  const endLate = new Set<string>()
  // A spawn answers its agent's id as the agent starts: a row still without
  // one this long after has no agent behind it.
  const orphans = new Set(
    list
      .filter(r => r.kind === 'agent' && r.status === 'running' && r.agentId === undefined)
      .filter(r => now - r.startedAt >= SPAWN_PENDING_MS)
      .map(r => r.id),
  )
  for (const r of list) {
    if (r.kind !== 'agent' || r.agentId === undefined) continue
    const info = byId.get(r.agentId)
    if (info) {
      if (!r.isListed) listed.add(r.id)
      const status = toStatus(info.status)
      if (r.status === 'running' && status !== 'running') endAs(status, r.id)
    } else if (r.status === 'running') {
      const ended = endedAgents.get(r.agentId)
      if (ended !== undefined) endAs(ended, r.id)
      else if (r.isListed || now - lastActiveOf(r) > AGENT_QUIET_MS) endLate.add(r.id)
    }
  }
  if (listed.size > 0) await update($, runs, l => l.map(r => (listed.has(r.id) ? { ...r, isListed: true } : r)))
  for (const [status, ids] of ends) await endRuns($, r => ids.has(r.id), status, now)
  if (endLate.size > 0) await endRuns($, r => endLate.has(r.id), 'done', now, false)
  if (orphans.size > 0) await endRuns($, r => orphans.has(r.id), 'failed', now)
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

// Keep only the context figures the pane draws (never the breakdown).
const toFill = (c: ContextFill): ContextFill => ({ tokens: c.tokens, window: c.window, percent: c.percent })

// Biggest first, empty ones dropped.
const biggest = (pieces: ContextPiece[]) => pieces.filter(p => p.tokens > 0).sort((a, b) => b.tokens - a.tokens)

// Fetch the window's breakdown for the Context dropdown, estimated locally as
// /context's summary does: no token-count requests, so it costs no tokens.
const loadDetail = async ($: EngineInterface) => {
  const measured = await $.session.usage({ breakdown: 'summary' })
  const b = measured.context.breakdown
  if (!b) return
  const servers = new Map<string, number>()
  for (const t of b.mcpTools) if (t.isLoaded) servers.set(t.serverName, (servers.get(t.serverName) ?? 0) + t.tokens)
  const detail: ContextDetail = {
    parts: b.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind, color: c.color })),
    max: b.rawMaxTokens,
    mcp: biggest([...servers].map(([name, n]) => ({ name, tokens: n }))),
    memory: biggest(b.memoryFiles.map(f => ({ name: f.path.split(/[\\/]/).pop() ?? f.path, tokens: f.tokens }))),
    skills: b.skills && { listed: b.skills.includedSkills, total: b.skills.totalSkills, tokens: b.skills.tokens },
    agents: { count: b.agents.length, tokens: b.agents.reduce((sum, a) => sum + a.tokens, 0) },
  }
  await update($, contextDetail, () => detail)
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
    hues: huesOf(p.hues),
    // Only a known color's name: a stored string is never drawn as a color.
    ...(isColorName(p.color) ? { color: p.color, ...(p.colorPicked === true ? { colorPicked: true } : {}) } : {}),
  }
}

// The first session color none of `taken` has, by the list's order; orange
// when every one is taken.
const freeColor = (taken: ReadonlySet<string>) =>
  SESSION_COLORS.find(c => !taken.has(c.name))?.name ?? SESSION_COLORS[0]!.name

// This session's color, picked at session start when it has none: the first
// one no other session publishes.
const pickColor = async ($: EngineInterface) => {
  if ((await read($, sessionColor)) !== null) return
  const now = await $.clock.now()
  const me = await read($, self)
  const taken = new Set<string>()
  for (const key of await $.store.keys().catch(() => [])) {
    if (!key.startsWith(PEER_PREFIX) || (me !== null && key === `${PEER_PREFIX}${me.id}`)) continue
    const peer = toPeer(await $.store.get(key).catch(() => undefined))
    if (peer?.color !== undefined && now - peer.updatedAt <= PEER_STALE_MS) taken.add(peer.color)
  }
  await update($, sessionColor, old => old ?? { name: freeColor(taken), isPicked: false })
}

// A published color map, keeping only whole palette slots.
const huesOf = (raw: unknown): Record<string, number> => {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 4 * MAX_RUNS)) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value % PALETTE.length
  }
  return out
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
  const myColor = await read($, sessionColor)
  const mine: Peer = {
    id: me.id,
    cwd: me.cwd,
    task: me.task,
    state,
    activity: isAgentsOnly ? `${plural(running.length, 'agent')} working` : state === 'working' ? m.activity : '',
    percent: isAgentsOnly ? agentsPercent : state === 'done' ? 100 : mainPercent(planNow, learned, since, now),
    updatedAt: now,
    // Its agents' colors, by the agent's id and its Agent call's id, so the
    // other panes draw each agent in the same color.
    hues: Object.fromEntries(
      list
        .filter(r => r.kind === 'agent' && r.hue !== undefined)
        .flatMap(r => [[r.id, r.hue!], ...(r.agentId ? [[r.agentId, r.hue!]] : [])]),
    ),
    ...(myColor !== null ? { color: myColor.name, ...(myColor.isPicked ? { colorPicked: true } : {}) } : {}),
  }
  const shape = JSON.stringify({ ...mine, updatedAt: 0 })
  if (shape !== lastShared || now - lastSharedAt >= HEARTBEAT_MS || now < lastSharedAt) {
    await $.store.set(`${PEER_PREFIX}${me.id}`, mine)
    lastShared = shape
    lastSharedAt = now
  }

  const found: Peer[] = []
  const heard = new Set<string>()
  const fresh = new Set<string>()
  const pickedPeers = new Set<string>()
  for (const key of await $.store.keys()) {
    if (!key.startsWith(PEER_PREFIX) || key === `${PEER_PREFIX}${me.id}`) continue
    const peer = toPeer(await $.store.get(key).catch(() => undefined))
    if (peer === undefined || now - peer.updatedAt > PEER_FORGET_MS) {
      await $.store.delete(key).catch(() => {})
      continue
    }
    // Every session's agent colors and own color, whatever its project, for Agents.
    peerHues.set(peer.id, peer.hues ?? {})
    // A color counts as taken only while its session still reports.
    if (peer.color !== undefined && now - peer.updatedAt <= PEER_STALE_MS) {
      peerColors.set(peer.id, peer.color)
      if (peer.colorPicked) pickedPeers.add(peer.id)
    } else peerColors.delete(peer.id)
    heard.add(peer.id)
    if (now - peer.updatedAt <= PEER_STALE_MS) fresh.add(peer.id)
    if (now - peer.updatedAt <= PEER_STALE_MS && sameProject(peer.cwd, me.cwd)) found.push(peer)
  }
  for (const id of [...peerHues.keys()]) if (!heard.has(id)) peerHues.delete(id)
  for (const id of [...peerColors.keys()]) if (!heard.has(id)) peerColors.delete(id)
  livePeers = fresh
  // Two sessions that started together may have taken the same color: the
  // one whose id sorts later moves to a free one, and one the person chose
  // stays put while an automatic one moves off it.
  if (myColor !== null && !myColor.isPicked) {
    const clash = [...peerColors].some(([id, name]) => name === myColor.name && (pickedPeers.has(id) || id < me.id))
    if (clash) {
      const name = freeColor(new Set(peerColors.values()))
      if (name !== myColor.name) await update($, sessionColor, () => ({ name, isPicked: false }))
    }
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

// ---------------------------------------------------------------- sounds

// Whether sounds are on (the store's setting, read at session start), the
// machine's system as `uname -s` names it, and the mod's own folder. Module
// values: a reload reads them again at its session.start.
let isSoundOn = true
let sysname: string | undefined
let pluginRoot: string | undefined
let isPlaying = false
const lastSoundAt = new Map<string, number>()

// The argv that plays a WAV file where `$.audio.play` cannot: a Windows or
// Linux terminal has no player of its own. undefined on macOS, which uses it.
const playerOf = (system: string, path: string): string[][] => {
  if (system === 'Darwin') return []
  if (system === 'Windows_NT') {
    const quoted = path.replace(/\//g, '\\').replace(/'/g, "''")
    return [['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${quoted}').PlaySync()`]]
  }
  return [['paplay', path], ['aplay', '-q', path]]
}

// Play one of the mod's sounds, unless sounds are off (the setting is read
// from the store each time, so `sound off` in any session silences this one
// too), one is playing, or the same kind (`key`, per session for
// `attention`) sounded moments ago. Resolves 'played', 'skipped', or why it
// could not play. Never awaited where it could hold up a tool, a prompt or a turn.
const playSound = async ($: EngineInterface, kind: 'attention' | 'done', key: string = kind, isForced = false) => {
  if (!isForced) isSoundOn = (await $.store.get(SOUND_KEY).catch(() => undefined)) !== false
  if ((!isSoundOn && !isForced) || isPlaying) return 'skipped'
  const now = await $.clock.now()
  const last = lastSoundAt.get(key)
  if (!isForced && last !== undefined && now >= last && now - last < SOUND_COOLDOWN_MS) return 'skipped'
  lastSoundAt.set(key, now)
  isPlaying = true
  try {
    sysname ??= (await $.session.machine().catch(() => undefined))?.sysname ?? ''
    const asset = `sounds/${kind}.wav`
    if (sysname === 'Darwin' || sysname === '') {
      await $.audio.play({ asset })
      return 'played'
    }
    pluginRoot ??= (await $.process.hookEnv().catch(() => ({}) as Record<string, string>)).CLAUDE_PLUGIN_ROOT
    if (!pluginRoot) return "the mod's folder is unknown (no CLAUDE_PLUGIN_ROOT)"
    const path = `${pluginRoot.replace(/[\\/]+$/, '')}/${asset}`
    const failures: string[] = []
    for (const argv of playerOf(sysname, path)) {
      const ran = await $.process.run(argv, { timeoutMs: 10_000 }).catch((error: unknown) => {
        failures.push(`${argv[0]}: ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      })
      if (ran?.exitCode === 0) return 'played'
      if (ran) failures.push(`${argv[0]} exited ${ran.exitCode}${ran.stderr.trim() ? `: ${plainLine(ran.stderr.trim())}` : ''}`)
    }
    return `could not play ${path} (${failures.join('; ') || 'no player for this system'})`
  } finally {
    isPlaying = false
  }
}

// Who waited for the person at the last scan: this session (from its own
// record) and the others by id. The first scan after a load only notes them,
// so a reload does not sound for what was already waiting.
let isWaitSeeded = false
let isSelfWaiting = false
const waitingBefore = new Set<string>()

// ---------------------------------------------------------------- other sessions

// Every Claude Code session on this computer keeps a record of itself under
// <claude folder>/sessions (`<pid>.json`: its id, name, folder and status,
// `waiting` with `waitingFor` while a dialog waits for the person) and writes
// its transcript and each subagent's log under <claude folder>/projects. They
// are read here, so sessions without this mod show too. The `<pid>.*.key`
// files beside the records hold access tokens and are never read.
const REMOTE_EVERY_MS = 2_000
// How much of a session's transcript is read for its last action.
const REMOTE_TAIL = 64 * 1024
// A subagent log is read from its start once, then only what was added; one
// longer than this is read from near its end, its earlier calls not counted.
const REMOTE_AGENT_FULL = 8 * 1024 * 1024
const REMOTE_CHUNK = 4 * 1024 * 1024
// A subagent log untouched this long is taken as finished or abandoned.
const REMOTE_AGENT_STALE_MS = 15 * 60_000
// A session that says it works but has written nothing this long has stopped.
const REMOTE_STALE_MS = 30 * 60_000
// A finished subagent stays listed, marked done, this long after its last write.
const REMOTE_DONE_SHOWN_MS = 10 * 60_000
const SHOWN_REMOTE = 4

// The colors other sessions with this mod gave their agents, as they publish
// them beside their status: session id -> agent id or Agent call id -> slot.
// An agent is drawn in its own session's color everywhere.
const peerHues = new Map<string, Record<string, number>>()
// The colors other sessions with this mod publish for themselves: session id
// -> color name, and the ids of every session that publishes at all.
const peerColors = new Map<string, string>()
let livePeers = new Set<string>()

// Where Claude Code keeps its files: the folder above `projects/` in this
// session's transcript path. Set at session start; undefined until then.
let claudeDir: string | undefined

// A transcript folder's name: the project's path with each character that is
// not a letter or digit turned into '-' (C:\work\app -> C--work-app).
const projectFolder = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

// What a session or agent's last call was doing, in the pane's own words.
const doingOf = (part: { name?: unknown; input?: unknown }) => {
  const tool = plainOf(part.name)
  const input = part.input && typeof part.input === 'object' ? (part.input as Record<string, unknown>) : {}
  return tool === '' ? '' : titlesOf(tool, input).doing
}

// The JSON entries among complete lines; a line that does not parse is skipped.
const jsonLines = (lines: readonly string[]) => {
  const out: Record<string, any>[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    try {
      const entry = JSON.parse(line)
      if (entry && typeof entry === 'object') out.push(entry)
    } catch {
      // cut by a read's edge
    }
  }
  return out
}

// The newest titles among transcript entries: one set with /rename
// (custom-title), and the one Claude gave the session (ai-title).
const titlesIn = (entries: readonly Record<string, any>[]) => {
  let custom = ''
  let ai = ''
  for (const entry of entries) {
    if (entry.type === 'custom-title') custom = plainLine(plainOf(entry.customTitle)) || custom
    if (entry.type === 'ai-title') ai = plainLine(plainOf(entry.aiTitle)) || ai
  }
  return { custom, ai }
}

// What a session's main loop did last: its newest call, or 'writing a reply'.
const lastDoing = (entries: readonly Record<string, any>[]) => {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i]!
    if (entry.isSidechain || entry.type !== 'assistant') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue
    const calls = content.filter(part => part?.type === 'tool_use')
    if (calls.length > 0) return doingOf(calls[calls.length - 1])
    if (content.some(part => part?.type === 'text')) return 'writing a reply'
  }
  return ''
}

// One subagent log as read so far: where the next read starts, the partial
// line it ended on, and what the complete lines said.
type AgentLog = {
  offset: number
  carry: string
  tools: number
  activity: string
  isDone: boolean
  startedAt: number
  type: string
  task: string
  // The Agent call that started it, as its own session's pane knows it.
  toolUseId: string
}
// A transcript's tail as read last: its size, the main loop's last action,
// and the session's title (the one it set with /rename, else the one Claude
// gave it), kept from earlier reads when the tail holds none.
type SessionTail = { size: number; activity: string; title: string; customTitle: string }
const agentLogs = new Map<string, AgentLog>()
const sessionTails = new Map<string, SessionTail>()
let isScanning = false
let lastScanAt = 0
// Whether the last scan found a session working, waiting or running agents:
// the ticker keeps animating for it without reading state each tick.
let isRemoteLive = false

// Read what a subagent log gained since the last read: count its calls, note
// its newest, and whether it handed back (SubagentHandback) or answered with
// no call, which ends its run.
const readAgentLog = async ($: EngineInterface, path: string, size: number, log: AgentLog) => {
  for (let reads = 0; log.offset < size && reads < 3; reads += 1) {
    const length = Math.min(REMOTE_CHUNK, size - log.offset)
    const text = await $.fs.read(path, { offset: log.offset, length })
    log.offset += length
    const lines = (log.carry + text).split('\n')
    log.carry = lines.pop() ?? ''
    for (const entry of jsonLines(lines)) {
      if (log.startedAt === 0 && typeof entry.timestamp === 'string') log.startedAt = Date.parse(entry.timestamp) || 0
      if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) continue
      const calls = entry.message.content.filter((part: any) => part?.type === 'tool_use')
      for (const call of calls) {
        if (call.name === 'SubagentHandback') log.isDone = true
        else {
          log.tools += 1
          log.activity = doingOf(call)
        }
      }
      if (calls.length === 0 && entry.message.stop_reason === 'end_turn') log.isDone = true
    }
  }
}

// The subagents still running in one session, oldest first.
const readAgents = async ($: EngineInterface, folder: string, now: number, live: Set<string>) => {
  const listed = await $.fs.list(folder).catch(() => [])
  const running: RemoteAgent[] = []
  for (const file of listed) {
    const id = /^agent-(.+)\.jsonl$/.exec(file.name)?.[1]
    if (file.kind !== 'file' || id === undefined) continue
    const path = `${folder}/${file.name}`
    // An old log is never opened, and one read before is let go once it goes quiet.
    if (now - file.mtimeMs > REMOTE_AGENT_STALE_MS) continue
    let log = agentLogs.get(path)
    live.add(path)
    if (log === undefined) {
      const meta = await $.fs.read(`${folder}/agent-${id}.meta.json`).catch(() => '{}')
      let parsed: Record<string, unknown> = {}
      try {
        const value = JSON.parse(meta)
        if (value && typeof value === 'object') parsed = value
      } catch {
        // no meta: named by its id
      }
      const isLong = file.size > REMOTE_AGENT_FULL
      log = {
        offset: isLong ? file.size - REMOTE_TAIL : 0,
        carry: '',
        tools: 0,
        activity: '',
        // Claude Code marks the meta file finished once the agent ends.
        isDone: parsed.finished === true,
        startedAt: isLong ? file.mtimeMs : 0,
        type: plainOf(parsed.agentType) || 'agent',
        task: plainOf(parsed.description),
        toolUseId: plainOf(parsed.toolUseId),
      }
      agentLogs.set(path, log)
      // A long log is read from inside a line: drop that partial line.
      if (isLong) log.carry = '\u0000'
    } else if (!log.isDone) {
      // A stopped agent writes no last answer; its meta file still says it finished.
      const meta = await $.fs.read(`${folder}/agent-${id}.meta.json`).catch(() => '')
      if (/"finished"\s*:\s*true/.test(meta)) log.isDone = true
    }
    if (file.size > log.offset) {
      await readAgentLog($, path, file.size, log).catch(() => {})
      if (log.carry.startsWith('\u0000')) log.carry = ''
    }
    // A finished one stays a while, so the person sees which ones finished.
    if (log.isDone && now - file.mtimeMs > REMOTE_DONE_SHOWN_MS) continue
    running.push({
      id,
      toolUseId: log.toolUseId,
      type: log.type,
      task: log.task,
      status: log.isDone ? 'done' : 'running',
      startedAt: log.startedAt || file.mtimeMs,
      ...(log.isDone ? { endedAt: file.mtimeMs } : {}),
      tools: log.tools,
      activity: log.activity,
      hue: 0,
    })
  }
  return running.sort((a, b) => a.startedAt - b.startedAt)
}

// Read every other session's record, its last action and its running
// subagents, at most once per REMOTE_EVERY_MS and never two at once. The
// ones working, waiting for the person or running subagents go to `remote`.
const scanRemote = async ($: EngineInterface) => {
  if (claudeDir === undefined || isScanning) return
  const now = await $.clock.now()
  if (now >= lastScanAt && now - lastScanAt < REMOTE_EVERY_MS) return
  isScanning = true
  lastScanAt = now
  try {
    // Asked each time: the session's id can change during it (/clear), and its
    // own record must never show as another session.
    const me = (await $.session.id().catch(() => undefined)) ?? (await read($, self))?.id
    const recordsDir = `${claudeDir}/sessions`
    let failure: string | null = null
    const records = await $.fs.list(recordsDir).catch((error: unknown) => {
      failure = `can't read ${recordsDir}: ${error instanceof Error ? error.message : String(error)}`
      return []
    })
    const live = new Set<string>()
    const found: RemoteSession[] = []
    // This session's own record says when a dialog of its own waits for the
    // person (a permission prompt too, which no event tells the mod).
    let isSelfWaitingNow = false
    for (const file of records) {
      // Only the records: never the token files beside them.
      if (file.kind !== 'file' || !/^\d+\.json$/.test(file.name)) continue
      let record: Record<string, unknown>
      try {
        const value = JSON.parse(await $.fs.read(`${recordsDir}/${file.name}`))
        if (!value || typeof value !== 'object') continue
        record = value
      } catch {
        continue
      }
      const id = plainOf(record.sessionId)
      const cwd = plainOf(record.cwd)
      const status = plainOf(record.status)
      const waitingFor = plainOf(record.waitingFor)
      if (id !== '' && id === me) isSelfWaitingNow = status === 'waiting' || waitingFor !== ''
      if (id === '' || cwd === '' || id === me || !/^[\w-]+$/.test(id)) continue
      const since = typeof record.statusUpdatedAt === 'number' ? record.statusUpdatedAt : file.mtimeMs

      const folder = `${claudeDir}/projects/${projectFolder(cwd)}`
      const transcript = `${folder}/${id}.jsonl`
      live.add(transcript)
      const stat = await $.fs.stat(transcript).catch(() => undefined)
      let tail = sessionTails.get(transcript)
      if (stat && stat.size !== tail?.size) {
        const offset = Math.max(0, stat.size - REMOTE_TAIL)
        const text = await $.fs.read(transcript, { offset, length: stat.size - offset }).catch(() => undefined)
        if (text !== undefined) {
          const lines = text.split('\n')
          if (offset > 0) lines.shift()
          const entries = jsonLines(lines)
          const titles = titlesIn(entries)
          tail = {
            size: stat.size,
            activity: lastDoing(entries),
            title: titles.ai || tail?.title || '',
            customTitle: titles.custom || tail?.customTitle || '',
          }
          sessionTails.set(transcript, tail)
        }
      }
      // Its name as the person knows it: the one set with /rename, else the
      // title Claude gave it; the name made from its folder only without one.
      const recordName = plainOf(record.name)
      const nameSource = plainOf(record.nameSource)
      const isNamed = recordName !== '' && nameSource !== '' && nameSource !== 'derived'
      const title = tail?.customTitle || (isNamed ? recordName : '') || tail?.title || ''
      const lastWrite = Math.max(since, stat?.mtimeMs ?? 0)
      const state: RemoteSession['state'] =
        status === 'waiting' || waitingFor !== ''
          ? 'waiting'
          : status === 'busy' && now - lastWrite < REMOTE_STALE_MS
            ? 'working'
            : 'idle'
      const agents = await readAgents($, `${folder}/${id}/subagents`, now, live)
      if (state === 'idle' && agents.length === 0) continue
      found.push({
        id,
        name: title || recordName || baseName(cwd),
        isTitled: title !== '',
        state,
        waitingFor: state === 'waiting' ? waitingFor || 'your answer' : '',
        since,
        activity: tail?.activity ?? '',
        agents,
      })
    }
    // Logs of sessions and agents no longer listed are forgotten.
    for (const key of [...agentLogs.keys()]) if (!live.has(key)) agentLogs.delete(key)
    for (const key of [...sessionTails.keys()]) if (!live.has(key)) sessionTails.delete(key)

    // Sessions waiting for the person first, then working ones.
    const rank = { waiting: 0, working: 1, idle: 2 }
    found.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
    // Animate only while something there moves: finished agents alone don't.
    isRemoteLive = found.some(r => r.state !== 'idle' || r.agents.some(a => a.status === 'running'))
    const before = await read($, remote)

    // Each session's own color: the one it publishes when it runs this mod;
    // else the one it was first shown in here, or a new one no other session
    // shown (nor this one) has, starting from a slot its id picks.
    const myColorName = (await read($, sessionColor))?.name
    const takenColors = new Set<string>(myColorName !== undefined ? [myColorName] : [])
    for (const r of found) {
      const published = peerColors.get(r.id)
      if (published !== undefined) {
        r.color = published
        takenColors.add(published)
      }
    }
    const keptColors = new Map(before.map(r => [r.id, r.color] as const))
    for (const r of [...found].sort((a, b) => a.id.localeCompare(b.id))) {
      if (r.color !== undefined) continue
      const kept = keptColors.get(r.id)
      if (isColorName(kept) && !takenColors.has(kept)) r.color = kept
      else {
        const start = hueOf(r.id) % SESSION_COLORS.length
        const free = SESSION_COLORS.map((_, i) => SESSION_COLORS[(start + i) % SESSION_COLORS.length]!.name)
        r.color = free.find(name => !takenColors.has(name)) ?? free[0]!
      }
      takenColors.add(r.color)
    }

    // An agent is drawn in the color its own session gave it (published beside
    // that session's status, when it runs this mod), so it reads the same in
    // every pane. Without one, it keeps the color it was first shown in here,
    // a new one taking the color fewest running agents have, this session's
    // own counted. Orange is never one: it is the Claude bar.
    const kept = new Map(before.flatMap(r => r.agents.map(a => [a.id, a.hue] as const)))
    const used = PALETTE.map(() => 0)
    const own = (await read($, runs)).filter(r => r.kind === 'agent' && r.status === 'running')
    for (const r of own) used[(r.hue ?? 0) % PALETTE.length]!++
    const unset: { a: RemoteAgent; avoid: number }[] = []
    for (const r of found) {
      const published = peerHues.get(r.id)
      for (const a of r.agents) {
        const hue = published?.[a.id] ?? (a.toolUseId !== '' ? published?.[a.toolUseId] : undefined) ?? kept.get(a.id)
        if (hue === undefined) {
          unset.push({ a, avoid: slotOf(r.color) })
          continue
        }
        a.hue = hue % PALETTE.length
        if (a.status === 'running') used[a.hue]!++
      }
    }
    // A new one never takes its own session's color.
    for (const { a, avoid } of unset) {
      const fewest = Math.min(...used.filter((_, i) => i !== avoid))
      a.hue = used.findIndex((k, i) => i !== avoid && k === fewest)
      if (a.status === 'running') used[a.hue]!++
    }
    remoteHues = new Set(found.flatMap(r => r.agents.filter(a => a.status === 'running').map(a => a.hue)))

    if (JSON.stringify(before) !== JSON.stringify(found)) await update($, remote, () => found)
    if ((await read($, remoteError)) !== failure) await update($, remoteError, () => failure)

    // Sound when this session starts to wait for the person. A session with
    // no pane of its own (it runs without this mod) is sounded for by one
    // pane only: the one whose id sorts first among the sessions that publish.
    const waitingNow = found.filter(r => r.state === 'waiting').map(r => r.id)
    if (isWaitSeeded) {
      if (isSelfWaitingNow && !isSelfWaiting) void playSound($, 'attention').catch(() => {})
      const isElected = me !== undefined && [...livePeers].every(id => me <= id)
      for (const id of waitingNow) {
        if (isElected && !waitingBefore.has(id) && !livePeers.has(id)) {
          void playSound($, 'attention', `attention:${id}`).catch(() => {})
        }
      }
    }
    isWaitSeeded = true
    isSelfWaiting = isSelfWaitingNow
    waitingBefore.clear()
    for (const id of waitingNow) waitingBefore.add(id)
  } finally {
    isScanning = false
  }
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
// `hot` is the session's own color.
const propColor = (look: Look, hot: string) =>
  look === 'fail' ? 'error' : look === 'cheer' ? 'success' : look === 'ask' ? 'warning' : hot

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
      description: 'Open the Claude at work pane; `color <name>` sets this session color, `sound on|off|test` the sounds',
      argumentHint: '[color <name>|sound on|off|test]',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    // Sounds on or off, as the person last set them in any session.
    isSoundOn = (await $.store.get(SOUND_KEY).catch(() => undefined)) !== false

    // Bring the learned averages from earlier sessions into this one.
    const saved = await $.store.get(STORE_KEY).catch(() => undefined)
    if (saved && typeof saved === 'object') await update($, typical, () => saved as Typical)

    // Usage as the status line has it now, and this week's tokens so far.
    const measured = await $.session.usage().catch(() => undefined)
    if (measured) await applyMeasure($, measured.rateLimits, measured.cost).catch(() => {})
    if (measured) await update($, context, () => toFill(measured.context))
    const week = await savedWeek($, await $.clock.now())
    await update($, usage, u => ({ ...u, weekTokens: week?.tokens ?? 0 }))

    // Who this session is, for the other sessions' Sessions lists. Its
    // project is its git repository's main root (the same for every worktree),
    // else its folder.
    const sessionId = await $.session.id().catch(() => undefined)
    const repo = await $.session.repo().catch(() => null)
    const project = repo?.root ?? e.cwd
    if (sessionId) await update($, self, old => ({ id: sessionId, cwd: project, task: old?.task ?? '' }))
    // This session's color, once: the first no other session has.
    await pickColor($).catch(() => {})

    // Where Claude Code keeps every session's files, for the other sessions
    // shown under Agents: the folder above projects/ in this transcript's path.
    const transcriptPath = (await $.session.info().catch(() => undefined))?.transcriptPath ?? ''
    const projectsAt = transcriptPath.replace(/\\/g, '/').lastIndexOf('/projects/')
    claudeDir = projectsAt > 0 ? transcriptPath.slice(0, projectsAt) : undefined

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
        // Read the other sessions on this computer beside the tick, not in it:
        // it runs at most every couple of seconds and never two at once.
        void scanRemote($).catch(() => {})
        // Another session working, waiting for the person or running agents
        // keeps the pane moving while this one rests.
        const isActive = isTurnBusy || hasRunningAgent || isRemoteLive
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

  on('command.run', { command: 'clawd-at-work' }, async ($, e) => {
    const [verb = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    const names = SESSION_COLORS.map(c => c.name).join(', ')
    if (verb === 'color' || verb === 'colour') {
      const now = await read($, sessionColor)
      if (value === '') {
        return { text: `This session's color is ${now?.name ?? 'orange'}${now?.isPicked ? '' : ' (picked automatically)'}. Colors: ${names}, or auto.` }
      }
      if (value === 'auto') {
        const taken = new Set([...peerColors.values()])
        await update($, sessionColor, () => ({ name: freeColor(taken), isPicked: false }))
        return { text: `This session's color is now ${(await read($, sessionColor))?.name}, picked automatically.` }
      }
      if (!isColorName(value)) return { text: `No color named "${value}". Colors: ${names}, or auto.` }
      await update($, sessionColor, () => ({ name: value, isPicked: true }))
      // Its agents already running keep theirs; new ones skip this color.
      return { text: `This session's color is now ${value}. The other sessions' panes show it within a few seconds.` }
    }
    if (verb === 'sound' || verb === 'sounds') {
      if (value === 'on' || value === 'off') {
        isSoundOn = value === 'on'
        await $.store.set(SOUND_KEY, isSoundOn).catch(() => {})
        return { text: `Sounds are ${value} (for every session).` }
      }
      if (value === 'test') {
        const isOn = (await $.store.get(SOUND_KEY).catch(() => undefined)) !== false
        const outcome = await playSound($, 'attention', 'attention', true).catch(
          (error: unknown) => `failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        const off = isOn ? '' : ' Sounds are off; turn them on with /clawd-at-work sound on.'
        return {
          text:
            outcome === 'played'
              ? `Played the "needs you" sound.${off}`
              : outcome === 'skipped'
                ? 'A sound is playing already; try again in a moment.'
                : `No sound: ${outcome}`,
        }
      }
      isSoundOn = (await $.store.get(SOUND_KEY).catch(() => undefined)) !== false
      return { text: `Sounds are ${isSoundOn ? 'on' : 'off'}. Use /clawd-at-work sound on, off or test.` }
    }
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

  // The mod adds nothing the model reads, so it costs no tokens: no tool, no
  // system-prompt note. Steps come from what Claude does (auto steps), or from
  // Claude Code's own todo list where a session has it. Only the main
  // conversation's list is shown; a subagent's changes nothing.
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
      endedAgents.delete(id)
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

  // The engine's rate-limit windows, cost and context fill, pushed as they move.
  on('session.measure', async ($, e, next) => {
    await applyMeasure($, e.rateLimits, e.cost)
    if (e.changed.includes('context')) {
      await update($, context, () => toFill(e.context))
      // An open Context dropdown follows; a closed one is fetched when opened.
      if (await read($, contextOpen)) void loadDetail($).catch(() => {})
    }
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
      // The turn is over and the next move is the person's: sound, unless
      // they stopped it themselves or it was over in a moment.
      if (!e.isAborted && e.durationMs >= DONE_SOUND_MIN_MS) {
        void playSound($, e.reason === 'error' || e.reason === 'refusal' ? 'attention' : 'done').catch(() => {})
      }
      // Learn how long a main turn usually takes; interrupted or failed ones
      // would skew it.
      if (e.reason === 'answer') await learn($, MAIN_KEY, e.durationMs).catch(() => {})
    } else {
      // An agent's run is one turn: its end ends the row, whatever the list
      // says yet (it lags, drops agents, and never names a workflow's).
      const status: Run['status'] = e.isAborted || e.reason === 'error' ? 'failed' : 'done'
      endedAgents.set(loop, status)
      await endRuns($, r => r.agentId === loop, status, now).catch(() => {})
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
  // answers (TodoWrite itself is not one: it is the plan).
  on('tool.call', async ($, e, next) => {
    const loop = e.agentId
    const input = e as unknown as Record<string, unknown>
    if (loop === undefined) {
      const { action, doing } = titlesOf(e.tool, input)
      const mood = moodOf(e.tool)
      await update($, main, m => ({ ...m, tools: m.tools + 1, mood, activity: doing }))
      // A question or a plan to approve waits for the person: sound now.
      if (mood === 'ask') void playSound($, 'attention').catch(() => {})
      if (e.tool === 'TodoWrite') return next(e)
      // Step, feed and file bookkeeping never gets in the way of the call itself.
      const id = e.tool_use_id
      await startAuto($, 'tool', `${e.tool}:${action}`, action).catch(() => {})
      const startedAt = await $.clock.now()
      await pushFeed($, { id, title: action, mood, status: 'running', startedAt }).catch(() => {})
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
    if (resumed) endedAgents.delete(resumed)
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
    const avoid = slotOf((await read($, sessionColor))?.name)
    await update($, runs, list => {
      const run: Run = {
        id,
        kind: 'agent',
        name: plainOf(e.subagentType) || 'agent',
        detail: plainOf(e.description),
        status: 'running',
        startedAt: now,
        tools: 0,
        hue: nextHue(list, avoid),
      }
      return [...list, run].slice(-MAX_RUNS)
    })
    let out: Awaited<ReturnType<typeof next>>
    try {
      out = await next(e)
    } catch (error) {
      // Nothing started here: the row must not run on with no agent behind it.
      await $.clock
        .now()
        .then(endedAt => patch($, r => r.id === id, { status: 'failed', endedAt }))
        .catch(() => {})
      throw error
    }
    // Guarded: a throw here would reach the .catch, which spawns the agent again.
    const agentId = out.agentId
    if (agentId) {
      await patch($, r => r.id === id, { agentId }).catch(() => {})
      // Its run may have ended before the spawn answered.
      const ended = endedAgents.get(agentId)
      if (ended !== undefined) {
        await $.clock
          .now()
          .then(at => endRuns($, r => r.id === id, ended, at))
          .catch(() => {})
      }
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
    // This session's own color: its Claude bar, steps, Recent and Files.
    const hot = hexOf((await read($, sessionColor))?.name)
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
    const [mainNow, feedNow, feedTotal, filesNow, summaryNow, usageNow, peersAll, remoteNow, remoteFailure] =
      await Promise.all([
        read($, main),
        read($, feed),
        read($, feedCount),
        read($, files),
        read($, summary),
        read($, usage),
        read($, peers),
        read($, remote),
        read($, remoteError),
      ])
    // A session shown under Agents with its agents is not listed again under Sessions.
    const peersNow = peersAll.filter(p => !remoteNow.some(r => r.id === p.id))

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
    // The heading is a dropdown: open (the default) it shows SHOWN_STEPS steps,
    // folded none.
    const isStepsOpen = !(await read($, stepsFolded))
    // Agents is a dropdown too: open (the default) it lists this session's
    // agents and the other sessions'; folded, only its heading and counts.
    const isAgentsOpen = !(await read($, agentsFolded))
    const planStart = isAuto
      ? Math.max(0, stepsNow.length - SHOWN_STEPS)
      : Math.max(0, Math.min(firstOpen - 2, stepsNow.length - SHOWN_STEPS))
    const stepsShown = isStepsOpen ? stepsNow.slice(planStart, planStart + SHOWN_STEPS) : []
    const hiddenSteps = isStepsOpen ? stepsNow.length - stepsShown.length : 0
    // Above the lists: the Claude bar, its activity line and a spacer while a
    // turn runs (3); the plan's heading, its shown steps (an active one with
    // its bar beneath) and a spacer.
    const planRows =
      stepsNow.length > 0 ? 2 + stepsShown.length + stepsShown.filter(s => s.status === 'active').length : 0
    // Context: one row, plus its open dropdown's lines. What occupies the
    // window comes first, biggest first; then free space, the compaction
    // buffer and on-demand schemas; then what the biggest ones hold.
    const [fill, isCtxOpen, detail] = await Promise.all([read($, context), read($, contextOpen), read($, contextDetail)])
    const detailLines = !isCtxOpen
      ? []
      : detail === null
        ? [{ kind: 'note' as const, label: '', text: 'counting…' }]
        : [
            ...[...detail.parts]
              .sort((a, b) => Number(b.kind === 'used') - Number(a.kind === 'used') || b.tokens - a.tokens)
              .map(p => ({ kind: 'part' as const, part: p })),
            ...(detail.mcp.length > 0 ? [{ kind: 'pieces' as const, label: 'MCP', pieces: detail.mcp }] : []),
            ...(detail.memory.length > 0 ? [{ kind: 'pieces' as const, label: 'Memory', pieces: detail.memory }] : []),
            ...(detail.skills
              ? [{ kind: 'note' as const, label: 'Skills', text: `${detail.skills.listed}/${detail.skills.total} listed · ${tokens(detail.skills.tokens)}` }]
              : []),
            ...(detail.agents.count > 0
              ? [{ kind: 'note' as const, label: 'Agents', text: `${detail.agents.count} described · ${tokens(detail.agents.tokens)}` }]
              : []),
          ]
    // Usage: heading, a row per limit window (or one saying none), the
    // Context row and its dropdown, tokens, spacer.
    const usageRows = 4 + Math.max(1, usageNow.limits.length) + detailLines.length
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
    // Other sessions under Agents: up to half the room. Each takes a heading
    // line; while it works, its bar and what it does; while it waits, what for;
    // and two lines per running subagent. Past half the room every line goes
    // compact (one per session and per subagent, plus a working session's
    // bar under its name), then the sessions that still
    // don't fit are counted on one line. A failed read takes one line.
    const remoteBudget = Math.max(4, Math.floor(room * 0.5))
    const fullRows = (r: RemoteSession) =>
      1 + (r.state === 'working' ? 1 + (r.activity !== '' ? 1 : 0) : 0) + (r.state === 'waiting' ? 1 : 0) + 2 * r.agents.length
    const compactRows = (r: RemoteSession) =>
      1 + (r.state === 'working' ? 1 : 0) + r.agents.filter(a => a.status === 'running').length
    const remoteCapped = isAgentsOpen ? remoteNow.slice(0, SHOWN_REMOTE) : []
    const isRemoteCompact = remoteCapped.reduce((k, r) => k + fullRows(r), 0) > remoteBudget
    const remoteRowsOf = isRemoteCompact ? compactRows : fullRows
    const remoteShown: RemoteSession[] = []
    let remoteUsed = isAgentsOpen && remoteFailure !== null ? 1 : 0
    for (const r of remoteCapped) {
      // The first session always shows, so one waiting for the person is never hidden.
      if (remoteShown.length > 0 && remoteUsed + remoteRowsOf(r) > remoteBudget) break
      remoteShown.push(r)
      remoteUsed += remoteRowsOf(r)
    }
    const hiddenRemote = isAgentsOpen ? remoteNow.length - remoteShown.length : 0
    if (hiddenRemote > 0) remoteUsed += 1
    const ownRoom = Math.max(3, room - remoteUsed)
    const agentBudget = Math.max(2, Math.floor(ownRoom * 0.7))
    // Every running agent always shows: it is live work, so it is never hidden
    // for space. When two rows each (title and bar) would not fit them all,
    // every row goes compact, one line each. Finished agents fill what is
    // left, newest first, and a last line counts the ones that did not fit.
    const runningAgentRuns = agents.filter(r => r.status === 'running')
    const isCompact = runningAgentRuns.length * 2 > agentBudget
    const heightOf = (r: Run) =>
      isCompact ? 1 : 2 + (open.includes(r.id) ? Math.max(1, Math.min(SHOWN_CALLS, r.calls?.length ?? 0)) : 0)
    const picked = new Set(isAgentsOpen ? runningAgentRuns.map(r => r.id) : [])
    let used = isAgentsOpen ? runningAgentRuns.reduce((sum, r) => sum + heightOf(r), 0) : 0
    for (const r of [...agents].reverse()) {
      if (!isAgentsOpen) break
      if (picked.has(r.id)) continue
      // With nothing running, the newest agent still shows, even past the budget.
      if (picked.size > 0 && used + heightOf(r) > agentBudget) break
      picked.add(r.id)
      used += heightOf(r)
    }
    const shownAgents = agents.filter(r => picked.has(r.id))
    const hiddenAgents = isAgentsOpen ? agents.length - shownAgents.length : 0
    const skillRoom = Math.max(1, ownRoom - Math.max(2, used + (hiddenAgents > 0 ? 1 : 0)))

    // The bar fills what the row leaves after indent, percent, time and tools.
    const columns = e.props.bodyColumns ?? 40
    const barWidth = Math.max(12, Math.min(28, columns - 24))

    const glyphOf = (r: Run) =>
      r.status === 'running' ? SPIN[n % SPIN.length] : r.status === 'done' ? '✓' : '✗'
    const colorOf = (r: Run) =>
      r.status === 'failed' ? 'error' : r.status === 'running' ? hot : 'success'

    // A one-line row's short bar: up to 10 columns of what `free` leaves (one
    // goes to the space before it), none when fewer than 5 would fit.
    const miniWidth = (free: number) => {
      const width = Math.min(10, free - 1)
      return width >= RUNNER[0]!.length + 2 ? width : 0
    }
    // That bar, with the mini Clawd at its head (or `runner` once it ended).
    const miniBar = (pct: number, color: string, seed: number, width: number, runner?: string) => {
      const track = width - RUNNER[0]!.length
      const filled = Math.round((Math.min(100, pct) / 100) * track)
      const isBlink = (n + seed * 5) % BLINK_EVERY === BLINK_EVERY - 1
      return (
        <Text>
          {' '}
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color={color} bold>
            {runner ?? (isBlink ? RUNNER_BLINK : RUNNER[n % RUNNER.length])}
          </Text>
          <Text dimColor>{'─'.repeat(track - filled)}</Text>
        </Text>
      )
    }

    // Compact agent, one line: status, type, a short bar, %, time, then the
    // tool count when it still fits, then its task. The type is cut only to
    // leave the bar room.
    const compactAgentRow = (r: Run) => {
      const color = r.status === 'failed' ? 'error' : PALETTE[(r.hue ?? 0) % PALETTE.length]!
      const pct = percent(r, learned, now)
      const tail = ` ${String(pct).padStart(3)}%  ${clock((r.endedAt ?? now) - r.startedAt)}`
      const name = clip(r.name, Math.max(10, columns - textWidth(` ${glyphOf(r)} ${tail}`) - 6))
      const left = columns - textWidth(` ${glyphOf(r)} ${name}${tail}`)
      const width = miniWidth(left)
      const tools = ` · ${plural(r.tools ?? 0, 'tool')}`
      const isToolsShown = left - (width > 0 ? width + 1 : 0) >= textWidth(tools)
      const runner = r.status === 'running' ? undefined : r.status === 'done' ? RUNNER_DONE : RUNNER_FAILED
      return (
        <Text wrap="truncate-end">
          {' '}
          <Text color={r.status === 'running' ? color : colorOf(r)}>{`${glyphOf(r)} `}</Text>
          {name}
          {width > 0 && miniBar(pct, color, r.hue ?? 0, width, runner)}
          <Text color={color}>{` ${String(pct).padStart(3)}%`}</Text>
          <Text dimColor>{`  ${clock((r.endedAt ?? now) - r.startedAt)}${isToolsShown ? tools : ''}  ${r.detail}`}</Text>
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
          color={r.status === 'failed' ? 'error' : r.status === 'running' ? hot : undefined}
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
            color={isFailed ? 'error' : s.status === 'done' ? 'success' : isActive ? hot : undefined}
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
            <Text color={hot}>{'━'.repeat(filled)}</Text>
            <Text color={hot} bold>{RUNNER[n % RUNNER.length]}</Text>
            <Text dimColor>{'─'.repeat(track - filled)}</Text>
            {` ${String(pct).padStart(3)}%`}
            <Text dimColor>{`  ${clock(now - (s.startedAt ?? now))}`}</Text>
          </Text>
        </Box>
      )
    }
    // The heading: ▾ while its steps show, ▸ while folded away; open, it
    // counts the earlier steps it leaves out. A Button cannot truncate, so its
    // words are cut to the width.
    const stepsLabel = isAuto ? 'Steps    ' : 'Plan     '
    const stepsCount = isAuto ? `${planDone} done · auto` : `${planDone}/${planNow.length} steps done`
    const stepsMore = hiddenSteps > 0 ? ` · ${hiddenSteps} more` : ''
    const toggleSteps = () => update($, stepsFolded, isFolded => !isFolded)
    const planRowsShown = (
      <Box flexDirection="column">
        <Button key="steps" plain onPress={toggleSteps}>
          <Text>
            <Text bold>{`${isStepsOpen ? '▾' : '▸'} ${stepsLabel}`}</Text>
            <Text dimColor>{clip(`${stepsCount}${stepsMore}`, Math.max(4, columns - 11))}</Text>
          </Text>
        </Button>
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
          <Text color={hot}>{'━'.repeat(mainFilled)}</Text>
          <Text color={hot} bold>{mainRunner}</Text>
          <Text dimColor>{'─'.repeat(mainTrack - mainFilled)}</Text>
          {` ${String(mainPct).padStart(3)}%`}
          <Text dimColor>{`  ${elapsed}`}</Text>
        </Text>
        <Text wrap="truncate-end">
          {'          '}
          <Text color={hot}>{mainNow.activity || 'thinking…'}</Text>
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
    // Context: how full the window is, a bar colored by how close it is to
    // full, then the tokens used against the window. A Button cannot
    // truncate, so the bar leaves room for the rest of the line. Pressed, it
    // opens a dropdown of what the window holds, as /context breaks it down.
    const ctxWidth = Math.max(6, Math.min(24, columns - 33))
    const ctxPct = Math.max(0, Math.min(100, fill?.percent ?? 0))
    const ctxFilled = Math.round((ctxPct / 100) * ctxWidth)
    const ctxColor = ctxPct >= ALERT_AT ? 'error' : ctxPct >= WARN_AT ? 'warning' : 'success'
    const toggleCtx = async () => {
      const isOpening = !(await read($, contextOpen))
      await update($, contextOpen, () => isOpening)
      if (isOpening) await loadDetail($).catch(() => {})
    }
    const contextHead = (
      <Button key="context" plain onPress={toggleCtx}>
        <Text bold>{isCtxOpen ? '▾ Context ' : '▸ Context '}</Text>
        {fill === null || fill.tokens === undefined || fill.percent === undefined ? (
          <Text dimColor>{fill === null ? 'not measured yet' : `after next reply · ${tokens(fill.window)}`}</Text>
        ) : (
          <Text>
            <Text color={ctxColor}>{'━'.repeat(ctxFilled)}</Text>
            <Text dimColor>{'─'.repeat(ctxWidth - ctxFilled)}</Text>
            <Text color={ctxPct >= WARN_AT ? ctxColor : undefined}>{` ${String(ctxPct).padStart(3)}%`}</Text>
            <Text dimColor>{`  ${tokens(fill.tokens)} / ${tokens(fill.window)}`}</Text>
          </Text>
        )}
      </Button>
    )
    const partWidth = Math.max(10, Math.min(22, columns - 24))
    const detailRow = (line: (typeof detailLines)[number]) => {
      if (line.kind === 'part') {
        const p = line.part
        const share = detail && detail.max > 0 ? Math.round((p.tokens / detail.max) * 100) : 0
        return (
          <Text wrap="truncate-end" dimColor={p.kind !== 'used'}>
            {'    '}
            <Text color={p.color}>{p.kind === 'free' ? '□' : p.kind === 'deferred' ? '◌' : '■'}</Text>
            {` ${padTo(clip(p.name, partWidth), partWidth)} ${tokens(p.tokens).padStart(6)}`}
            <Text dimColor>{p.kind === 'deferred' ? '  on demand' : ` ${String(share).padStart(3)}%`}</Text>
          </Text>
        )
      }
      if (line.kind === 'pieces') {
        const named = line.pieces.slice(0, SHOWN_PIECES).map(p => `${p.name} ${tokens(p.tokens)}`)
        const more = line.pieces.length - SHOWN_PIECES
        return (
          <Text wrap="truncate-end">
            {'      '}
            <Text bold>{line.label.padEnd(7)}</Text>
            <Text dimColor>{named.join(' · ') + (more > 0 ? ` · +${more} more` : '')}</Text>
          </Text>
        )
      }
      return (
        <Text wrap="truncate-end">
          {'      '}
          {line.label !== '' && <Text bold>{line.label.padEnd(7)}</Text>}
          <Text dimColor>{line.text}</Text>
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
        {contextHead}
        {detailLines.map(detailRow)}
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
          <Text color={f.status === 'failed' ? 'error' : f.status === 'running' ? hot : 'success'}>
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
          <Text color={f.isEdited ? hot : undefined} dimColor={!f.isEdited}>
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
      working: { mark: SPIN[n % SPIN.length]! },
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
      // Its own color; a wait, a failure or a finish keeps the state's color on its mark.
      const own = hexOf(p.color)
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            {'  '}
            <Text color={PEER_LOOK[p.state].color ?? own} dimColor={p.state === 'idle'}>
              {PEER_LOOK[p.state].mark}
            </Text>
            <Text color={own} dimColor={!isLive}>{` ${isLive ? padTo(task, taskRoom) : task}`}</Text>
            {isLive && <Text color={PEER_LOOK[p.state].color ?? own}>{pct}</Text>}
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

    // Other sessions: a bar like an agent row's, `indent` columns in, with a
    // mini Clawd running at its head (or `runner` once it ended) and `suffix`
    // after the percent.
    const barLine = (indent: number, pct: number, color: string, seed: number, suffix: string, runner?: string) => {
      const width = Math.max(RUNNER[0]!.length + 3, Math.min(barWidth, columns - indent - 5 - suffix.length))
      const track = width - RUNNER[0]!.length
      const filled = Math.round((Math.min(100, pct) / 100) * track)
      const isBlink = (n + seed * 5) % BLINK_EVERY === BLINK_EVERY - 1
      return (
        <Text wrap="truncate-end">
          {' '.repeat(indent)}
          <Text color={color}>{'━'.repeat(filled)}</Text>
          <Text color={color} bold>
            {runner ?? (isBlink ? RUNNER_BLINK : RUNNER[n % RUNNER.length])}
          </Text>
          <Text dimColor>{'─'.repeat(track - filled)}</Text>
          {` ${String(pct).padStart(3)}%`}
          <Text dimColor>{suffix}</Text>
        </Text>
      )
    }
    const remotePercent = (a: RemoteAgent) =>
      Math.max(0, Math.min(MAX_ESTIMATE, Math.floor(((now - a.startedAt) / typicalMs(learned, a.type)) * 100)))
    // Waiting for the person: the heading flashes, twice a second.
    const isFlash = Math.floor(n / 2) % 2 === 0
    const remoteRow = (r: RemoteSession) => {
      const isWaiting = r.state === 'waiting'
      const elapsed = clock(Math.max(0, now - r.since))
      // One line each, its finished agents give up their rows to a count.
      const agentsShown = isRemoteCompact ? r.agents.filter(a => a.status === 'running') : r.agents
      const doneHidden = r.agents.length - agentsShown.length
      // The state words leave the name at least 8 columns.
      const word = clip(
        (isWaiting
          ? isRemoteCompact ? `needs you · ${r.waitingFor}` : 'needs you'
          : r.state === 'working' ? `working ${elapsed}` : 'idle') + (doneHidden > 0 ? ` · ${doneHidden} done` : ''),
        Math.max(9, columns - 13),
      )
      // A title is cut at its end; a name made from the folder from its front,
      // keeping the part that tells such names apart.
      const nameRoom = Math.max(8, columns - 5 - textWidth(word))
      const name = r.isTitled ? clip(r.name, nameRoom) : clipStart(r.name, nameRoom)
      const mark = isWaiting ? (isFlash ? '!' : ' ') : r.state === 'working' ? SPIN[n % SPIN.length] : '○'
      // Its own color (the one it chose, when it runs this mod): mark, name and bar.
      const own = hexOf(r.color)
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">
            {' '}
            <Text color={isWaiting ? 'warning' : own} bold>
              {mark}
            </Text>
            <Text color={own} bold>{` ${name}`}</Text>
            {'  '}
            <Text
              color={isWaiting ? 'warning' : r.state === 'working' ? own : undefined}
              dimColor={r.state === 'idle'}
              inverse={isWaiting && isFlash}
              bold={isWaiting}
            >
              {word}
            </Text>
          </Text>
          {!isRemoteCompact && isWaiting && (
            <Text wrap="truncate-end" color="warning">{`    ${clip(r.waitingFor, Math.max(4, columns - 4))}`}</Text>
          )}
          {/* A working session's bar sits under its name, compact or not. */}
          {r.state === 'working' &&
            barLine(4, mainPercent([], learned, r.since, now), own, hueOf(r.id), `  ${elapsed}`)}
          {!isRemoteCompact && r.state === 'working' && r.activity !== '' && (
            <Text wrap="truncate-end" dimColor>{`    ${clip(r.activity, Math.max(4, columns - 4))}`}</Text>
          )}
          {agentsShown.map(a => {
            const color = PALETTE[(a.hue ?? hueOf(a.id)) % PALETTE.length]!
            // A finished one: ✓, a full bar ending in the done face, its run time.
            const isDone = a.status === 'done'
            const pct = isDone ? 100 : remotePercent(a)
            const time = clock(Math.max(0, (a.endedAt ?? now) - a.startedAt))
            const spin = isDone ? '✓' : SPIN[(n + hueOf(a.id)) % SPIN.length]
            const runner = isDone ? RUNNER_DONE : undefined
            // A subagent is told apart by its task, not its type (the type
            // only when it has no task).
            const task = a.task || a.type
            if (isRemoteCompact) {
              // Indent and spinner, a short bar, percent and time; then the task.
              const rest = textWidth(`   ${spin} ${String(pct).padStart(3)}%  ${time}`)
              const width = miniWidth(columns - rest)
              const room = columns - rest - (width > 0 ? width + 1 : 0) - 2
              return (
                <Text wrap="truncate-end">
                  {'   '}
                  <Text color={color}>{spin}</Text>
                  {width > 0 && miniBar(pct, color, a.hue ?? 0, width, runner)}
                  <Text color={color}>{` ${String(pct).padStart(3)}%`}</Text>
                  <Text dimColor>{`  ${time}${room >= 4 && task !== '' ? `  ${clip(task, room)}` : ''}`}</Text>
                </Text>
              )
            }
            return (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  {'   '}
                  <Text color={color}>{`${spin} `}</Text>
                  <Text dimColor={isDone}>{clip(task, Math.max(4, columns - 5))}</Text>
                </Text>
                {barLine(5, pct, color, hueOf(a.id), `  ${time} · ${plural(a.tools, 'tool')}`, runner)}
              </Box>
            )
          })}
        </Box>
      )
    }
    const remoteAgents = remoteNow.reduce((k, r) => k + r.agents.filter(a => a.status === 'running').length, 0)
    // The Agents heading: what runs here and elsewhere, folded or open. Folded,
    // finished ones are counted too, since none of them shows.
    const doneHere = agents.length - runningAgentRuns.length
    const agentsCount = [
      runningAgentRuns.length > 0 ? `${runningAgentRuns.length} running` : '',
      doneHere > 0 && (runningAgentRuns.length > 0 || !isAgentsOpen) ? `${doneHere} done` : '',
      remoteAgents > 0 ? `${remoteAgents} in other sessions` : '',
    ]
      .filter(Boolean)
      .join(' · ')
      .replace(/^(?=.)/, '   ')
    const toggleAgents = () => update($, agentsFolded, isFolded => !isFolded)

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
                <Text color={propColor(look, hot)} bold>
                  {i === art.propRow ? prop : ' '.repeat(PROP_WIDTH)}
                </Text>
              </Text>
            ))}
          </Box>
          <Box flexDirection="column" marginLeft={2}>
            <Text> </Text>
            <Text bold color={isBusy ? hot : undefined} dimColor={!isBusy}>
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
        <Button key="agents" plain onPress={toggleAgents}>
          <Text wrap="truncate-end">
            <Text bold>{`${isAgentsOpen ? '▾' : '▸'} Agents`}</Text>
            <Text dimColor>{clip(agentsCount, Math.max(4, columns - 8))}</Text>
          </Text>
        </Button>
        {!isAgentsOpen ? null : agents.length === 0 ? (
          remoteShown.length === 0 && <Text dimColor> none yet</Text>
        ) : (
          shownAgents.map(isCompact ? compactAgentRow : agentRow)
        )}
        {hiddenAgents > 0 && <Text dimColor>{` +${hiddenAgents} more finished`}</Text>}
        {remoteShown.map(remoteRow)}
        {hiddenRemote > 0 && <Text dimColor>{` +${hiddenRemote} more sessions`}</Text>}
        {isAgentsOpen && remoteFailure !== null && (
          <Text wrap="truncate-end" color="error">{` other sessions: ${remoteFailure}`}</Text>
        )}
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
