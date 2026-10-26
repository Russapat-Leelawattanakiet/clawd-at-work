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
}

// What the main Claude loop is doing in its current turn.
export type MainTurn = {
  // Shown under the Claude bar: thinking, writing a reply, or a tool + target.
  activity: string
  // Model requests (steps) and tool calls made so far this turn.
  steps: number
  tools: number
}

// Learned typical run time per agent type, kept across sessions in $.store.
export type Typical = Record<string, { avgMs: number; n: number }>

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
    }
  }
}
