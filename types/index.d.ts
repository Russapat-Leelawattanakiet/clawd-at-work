// One tool call made inside an agent, for the agent row's dropdown.
export type Call = {
  id: string
  tool: string
  // Its main argument, shortened: a file name, pattern, command or query.
  target: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
}

// One tracked piece of work: a Skill load or an Agent (subagent) run.
export type Run = {
  id: string
  kind: 'agent' | 'skill'
  // Skill name, or the agent's type (Explore, Plan, general-purpose, ...).
  name: string
  // The agent's short task description; empty for skills.
  detail: string
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
  // Agents: the id `$.agent.list()` reports, once the spawn has answered.
  agentId?: string
  // Agents: palette slot, fixed at spawn so each agent keeps its color.
  hue?: number
  // Agents: tool calls made inside the agent's loop so far.
  tools?: number
  // Agents: the most recent of those calls, newest last.
  calls?: Call[]
  // Agents: set once its duration has been fed into the learned averages.
  isLearned?: boolean
  // Skills: the loop that loaded it (a subagent's id; absent on the main loop),
  // so the skill counts as active until that loop's turn ends.
  loopId?: string
}

// One step of the plan Claude declares for the current task.
export type PlanStep = {
  title: string
  status: 'pending' | 'active' | 'done'
  // When the step became active and when it was marked done, for its bar.
  startedAt?: number
  endedAt?: number
  // Auto steps only: what kind of work it is (its bar is timed against that
  // kind's learned typical time), the action it stands for, so a repeat of
  // the same action merges into it, and how many times it ran.
  kind?: 'tool' | 'think'
  key?: string
  count?: number
  // Auto tool steps only: the call it stands for last failed or was refused.
  isFailed?: boolean
}

// What kind of work an action is: it picks Clawd's prop, the word beside
// Clawd and the feed's icon.
export type Mood = 'think' | 'write' | 'read' | 'search' | 'edit' | 'run' | 'web' | 'agent' | 'ask' | 'tool'

// What the main Claude loop is doing in its current turn.
export type MainTurn = {
  // Shown under the Claude bar: thinking, writing a reply, or a tool + target.
  activity: string
  // Model requests (steps) and tool calls made so far this turn.
  steps: number
  tools: number
  // The kind of work it is doing now; absent reads as thinking.
  mood?: Mood
  // Tool calls that failed or were refused this turn, and when the last did.
  failed?: number
  failedAt?: number
}

// One main-loop tool call, for the Recent feed under a declared plan.
export type FeedItem = {
  id: string
  // Plain words for the call: "Read register.tsx", "Run npm test".
  title: string
  mood: Mood
  status: 'running' | 'done' | 'failed'
  startedAt: number
  endedAt?: number
}

// A file Claude worked on since the last prompt: read by the main loop, or
// edited by any loop.
export type TouchedFile = {
  path: string
  // The file name alone, as shown.
  name: string
  isEdited: boolean
}

// The main loop's last finished turn, for the Done line shown while idle.
export type TurnSummary = {
  durationMs: number
  tools: number
  failed: number
  isAborted: boolean
  // Ended by an API error or a refusal rather than an answer.
  isFailed: boolean
  endedAt: number
}

// Learned typical run time per agent type, kept across sessions in $.store.
export type Typical = Record<string, { avgMs: number; n: number }>

// One rate-limit window as the engine reports it: `five_hour` (the session
// limit) or `seven_day` (the weekly limit).
export type Limit = {
  kind: string
  // 0 to 100 (past 100 on an exceeded spend limit).
  percentUsed: number
  // When the window resets, ISO 8601.
  resetsAt?: string
}

// Tokens counted in this week's window, kept across sessions in $.store; the
// count starts over once `resetsAt` has passed.
export type WeekTokens = { tokens: number; resetsAt: string }

// What the Usage section shows.
export type Usage = {
  limits: Limit[]
  // Tokens every turn of this session used (main loop and agents), all four
  // counts summed: input, output, cache reads and cache writes.
  sessionTokens: number
  // Tokens counted in this week's window, across sessions with the mod.
  weekTokens: number
  // The session's cost in US dollars; absent where the host keeps no ledger.
  usd?: number
}

// This session as it reports itself to the others in the same project.
export type SelfInfo = {
  id: string
  // Its project: the git repository's main root, else the session's folder.
  cwd: string
  // What the person last asked, one line; '' before the first prompt.
  task: string
}

// One session's status as it publishes it in $.store, read by the other
// sessions' panes for their Sessions list.
export type Peer = {
  id: string
  cwd: string
  task: string
  state: 'working' | 'waiting' | 'done' | 'failed' | 'idle'
  // What it is doing right now, while working.
  activity: string
  // Its Claude bar's percent.
  percent: number
  // When it last published, in $.clock.now() time; stale ones drop off.
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'clawd-at-work': {
      runs: Shaped<Run[]>
      // When the main loop's current turn started; null while idle.
      busySince: number | null
      // Animation frame counter, bumped by the ticker while busy.
      frame: number
      // The steps Claude declared for this task, through its plan tool; empty
      // until it declares some, cleared by each new prompt.
      plan: PlanStep[]
      // Steps made automatically from what the main loop actually does (each
      // tool call, each stretch of thinking or writing), shown when no plan is
      // declared; cleared by each new prompt.
      autoSteps: PlanStep[]
      // The main loop's live activity for the Claude bar.
      main: MainTurn
      // Ids of the agent rows whose tool dropdown is open.
      expanded: string[]
      // Session copy of the learned averages, so drawing never waits on $.store.
      typical: Typical
      // Rate-limit windows, token counts and cost for the Usage section.
      usage: Usage
      // The main loop's recent tool calls, newest last; cleared by each new prompt.
      feed: FeedItem[]
      // Every main-loop call pushed to the feed since the last prompt, past
      // the ones it keeps too.
      feedCount: number
      // Files read or edited since the last prompt, in the order first touched.
      files: TouchedFile[]
      // The last finished main turn; null until one ends, cleared by each new prompt.
      summary: TurnSummary | null
      // This session's id, folder and task, set at session start; null before.
      self: SelfInfo | null
      // Other sessions working in the same project, as they last published.
      peers: Peer[]
    }
  }
}
