import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register } from 'claude-code'

import type { Call, MainTurn, PlanStep, Run, Typical } from '../types'

const PANE = 'clawd-at-work'
const TITLE = 'Claude at work'
// Ticker period: ~4 fps keeps the mascot lively without flooding redraws.
const TICK_MS = 250
// Poll `$.agent.list()` every Nth tick (~1 s) while agents are running.
const POLL_EVERY = 4
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

// What a tool call works on: the first naming field of its input, with a
// path cut to its file name and one line of at most TARGET_MAX characters.
const targetOf = (input: Record<string, unknown>) => {
  for (const field of TARGET_FIELDS) {
    const value = input[field]
    if (typeof value !== 'string' || value === '') continue
    const text = field.endsWith('path') ? (value.split(/[\\/]/).pop() ?? value) : value
    const line = text.split('\n')[0] ?? ''
    return line.length > TARGET_MAX ? `${line.slice(0, TARGET_MAX - 1)}…` : line
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
    return [{ title: text.length > STEP_MAX ? `${text.slice(0, STEP_MAX - 1)}…` : text, status: status(step?.status) }]
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

// Plain words for an auto step: what the tool does, then what it works on.
const ACTIONS: Record<string, string> = {
  Read: 'Read',
  Edit: 'Edit',
  Write: 'Write',
  NotebookEdit: 'Edit notebook',
  Bash: 'Run',
  PowerShell: 'Run',
  Grep: 'Search',
  Glob: 'Find files',
  WebSearch: 'Search the web',
  WebFetch: 'Fetch',
  Agent: 'Start agent',
  Skill: 'Load skill',
  AskUserQuestion: 'Ask you a question',
  Artifact: 'Publish page',
  ToolSearch: 'Load tools',
}
const actionTitle = (tool: string, target: string) => `${ACTIONS[tool] ?? toolName(tool)}${target ? ` ${target}` : ''}`

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

const setActivity = ($: EngineInterface, activity: string) =>
  update($, main, m => (m.activity === activity ? m : { ...m, activity }))

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

// Sync agent runs with what the engine reports, and learn from the ones
// that just finished successfully.
const pollAgents = async ($: EngineInterface) => {
  const agents = await $.agent.list()
  const byId = new Map(agents.map(a => [a.id, a]))
  const now = await $.clock.now()
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

// ---------------------------------------------------------------- mascot

// Clawd, 4 rows tall. While busy it shuffles its feet, waves its arms, bobs
// and blinks now and then; idle it sits still with its eyes shut.
const mascot = (n: number, isBusy: boolean): string[] => {
  const f = n % 8
  const isBlink = !isBusy || n % 17 === 0
  const isArmsUp = isBusy && f % 2 === 1
  const isFeetSwapped = isBusy && f % 4 >= 2
  const isBobUp = isBusy && (f === 2 || f === 6)

  const head = isArmsUp
    ? isBlink ? '▗▐█████▌▖' : '▗▐▛███▜▌▖'
    : isBlink ? ' ▐█████▌ ' : ' ▐▛███▜▌ '
  const body = isArmsUp ? ' ▜█████▛ ' : '▝▜█████▛▘'
  const feet = isFeetSwapped ? '  ▝▝ ▘▘  ' : '  ▘▘ ▝▝  '
  const blank = '         '

  return isBobUp ? [head, body, feet, blank] : [blank, head, body, feet]
}

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

        if (hasRunningAgent && tick % POLL_EVERY === 0) await pollAgents($)
        // Only redraw while something is happening; idle stays quiet.
        if (isTurnBusy || hasRunningAgent) await update($, frame, n => n + 1)
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
      await update($, main, () => ({ ...IDLE_MAIN, activity: 'thinking…' }))
    } else {
      const id = e.agentId
      await patch($, r => r.kind === 'agent' && r.agentId === id, {
        status: 'running',
        endedAt: undefined,
      })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    const loop = e.agentId
    // Skills stay "active" for the rest of the turn that loaded them.
    await patch($, r => r.kind === 'skill' && r.status === 'running' && r.loopId === loop, {
      status: e.isAborted ? 'failed' : 'done',
      endedAt: now,
    })
    if (loop === undefined) {
      await update($, busySince, () => null)
      await update($, main, () => IDLE_MAIN)
      await finishAuto($).catch(() => {})
      // Learn how long a main turn usually takes; interrupted ones would skew it.
      if (!e.isAborted) await learn($, MAIN_KEY, e.durationMs).catch(() => {})
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
    void update($, main, m => ({ ...m, steps: m.steps + 1, activity: 'thinking…' })).catch(() => {})
    void startAuto($, 'think', 'think', 'Thinking').catch(() => {})
    let last = 'thinking'
    for await (const c of next(e)) {
      const kind = c.kind === 'tool' ? `tool:${c.name}` : c.kind === 'text' || c.kind === 'thinking' ? c.kind : last
      if (kind !== last) {
        last = kind
        const activity =
          c.kind === 'tool' ? `getting ready: ${toolName(c.name)}…` : kind === 'text' ? 'writing reply…' : 'thinking…'
        void setActivity($, activity).catch(() => {})
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
    if (loop === undefined) {
      const target = targetOf(e as unknown as Record<string, unknown>)
      await update($, main, m => ({
        ...m,
        tools: m.tools + 1,
        activity: `${toolName(e.tool)}${target ? `  ${target}` : ''}`,
      }))
      if (e.tool === PLAN_TOOL_FULL) return next(e)
      // Step bookkeeping never gets in the way of the call itself.
      await startAuto($, 'tool', `${e.tool}:${target}`, actionTitle(e.tool, target)).catch(() => {})
      const ran = await next(e)
      await finishAuto($).catch(() => {})
      return ran
    }

    const call: Call = {
      id: e.tool_use_id,
      tool: e.tool,
      target: targetOf(e as unknown as Record<string, unknown>),
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
    await patchCall($, loop, call.id, {
      status: ran.deny !== undefined || ran.isError ? 'failed' : 'done',
      endedAt: await $.clock.now(),
    })
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
      await patch($, r => r.id === id, { status: 'failed', endedAt: await $.clock.now() })
    }
    return ran
    // The tracker only observes: if its bookkeeping fails, let the call through.
  }).catch(($, e, next) => next(e))

  // Agents: recorded as the spawn starts; the ticker keeps their status.
  on('agent.spawn', async ($, e, next) => {
    const now = await $.clock.now()
    const id = e.tool_use_id
    // Next palette slot after the newest agent's, so neighbours never match.
    await update($, runs, list => {
      const last = list.filter(r => r.kind === 'agent').at(-1)
      const hue = last?.hue === undefined ? 0 : (last.hue + 1) % PALETTE.length
      const run: Run = {
        id,
        kind: 'agent',
        name: e.subagentType || 'agent',
        detail: e.description,
        status: 'running',
        startedAt: now,
        tools: 0,
        hue,
      }
      return [...list, run].slice(-MAX_RUNS)
    })
    const out = await next(e)
    if (out.agentId) {
      await patch($, r => r.id === id, { agentId: out.agentId })
    } else {
      // Refused or answered by a hook: nothing actually started.
      await patch($, r => r.id === id, { status: 'failed', endedAt: await $.clock.now() })
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
    const isBusy = since !== null || runningAgents > 0

    const label =
      since !== null ? 'working' : runningAgents > 0 ? 'agents working' : 'resting  z z'
    const elapsed = since !== null ? clock(now - since) : ''
    const counts = `${agents.length} agent${agents.length === 1 ? '' : 's'} · ${skills.length} skill${skills.length === 1 ? '' : 's'}`

    // Rows left under the mascot (4) + spacer + 2 headings. Agents get ~70%
    // of the room, newest first: two rows each, plus an open dropdown's
    // tool lines. Skills get the rest.
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24
    // Above the lists: the Claude bar, its activity line and a spacer while a
    // turn runs (3); the plan's heading, its shown steps and a spacer.
    const planRows = stepsNow.length > 0 ? 2 + Math.min(SHOWN_STEPS, stepsNow.length) : 0
    const room = Math.max(3, bodyRows - 8 - (since !== null ? 3 : 0) - planRows)
    const agentBudget = Math.max(2, Math.floor(room * 0.7))
    // Two rows each: title and bar.
    const heightOf = (r: Run) =>
      2 + (open.includes(r.id) ? Math.max(1, Math.min(SHOWN_CALLS, r.calls?.length ?? 0)) : 0)
    const shownAgents: Run[] = []
    let used = 0
    for (const r of [...agents].reverse()) {
      // The newest agent always shows, even when its dropdown overflows.
      if (shownAgents.length > 0 && used + heightOf(r) > agentBudget) break
      shownAgents.unshift(r)
      used += heightOf(r)
    }
    const skillRoom = Math.max(1, room - Math.max(2, used))

    // The bar fills what the row leaves after indent, percent, time and tools.
    const columns = e.props.bodyColumns ?? 40
    const barWidth = Math.max(12, Math.min(28, columns - 24))

    const glyphOf = (r: Run) =>
      r.status === 'running' ? SPIN[n % SPIN.length] : r.status === 'done' ? '✓' : '✗'
    const colorOf = (r: Run) =>
      r.status === 'failed' ? 'error' : r.status === 'running' ? ORANGE : 'success'

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
    const mainNow = await read($, main)
    const mainPct =
      planNow.length > 0
        ? planPercent(planNow, learned, now)
        : since === null
          ? 0
          : Math.min(MAX_ESTIMATE, Math.floor(((now - since) / typicalMs(learned, MAIN_KEY)) * 100))
    const mainWidth = Math.max(14, Math.min(40, columns - 28))

    // Plan: every step on one line each: status, title, and its own bar.
    // Done bars are full, pending ones empty, and the active one fills by
    // time with the mini Clawd running at its head. A declared plan shows a
    // window starting just before its first unfinished step; auto steps show
    // the newest, the step in progress at the bottom.
    const planDone = stepsNow.filter(s => s.status === 'done').length
    const firstOpen = Math.max(0, stepsNow.findIndex(s => s.status !== 'done'))
    const planStart = isAuto
      ? Math.max(0, stepsNow.length - SHOWN_STEPS)
      : Math.max(0, Math.min(firstOpen - 2, stepsNow.length - SHOWN_STEPS))
    const titleWidth = Math.max(8, Math.min(24, Math.floor((columns - 10) * 0.45)))
    const stepWidth = Math.max(RUNNER[0]!.length + 3, Math.min(28, columns - titleWidth - 12))
    const stepRow = (s: PlanStep) => {
      const pct = stepPercent(s, learned, now)
      const full = s.count !== undefined && s.count > 1 ? `${s.title} ×${s.count}` : s.title
      const title = full.length > titleWidth ? `${full.slice(0, titleWidth - 1)}…` : full.padEnd(titleWidth)
      const isActive = s.status === 'active'
      const track = isActive ? stepWidth - RUNNER[0]!.length : stepWidth
      const filled = Math.round((pct / 100) * track)
      return (
        <Text wrap="truncate-end">
          {'  '}
          <Text color={s.status === 'done' ? 'success' : isActive ? HOT : undefined} dimColor={s.status === 'pending'}>
            {s.status === 'done' ? '✓' : isActive ? SPIN[n % SPIN.length] : '○'}
          </Text>
          <Text dimColor={!isActive}>{` ${title} `}</Text>
          <Text color={s.status === 'done' ? 'success' : HOT}>{'━'.repeat(filled)}</Text>
          {isActive && <Text color={HOT} bold>{RUNNER[n % RUNNER.length]}</Text>}
          <Text dimColor>{'─'.repeat(track - filled)}</Text>
          <Text dimColor={!isActive}>{` ${String(pct).padStart(3)}%`}</Text>
        </Text>
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
        {stepsNow.slice(planStart, planStart + SHOWN_STEPS).map(stepRow)}
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

    const art = mascot(n, isBusy)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexDirection="column">
            {art.map(line => (
              <Text color={ORANGE} dimColor={!isBusy}>
                {line}
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
        {since !== null && mainRows}
        {stepsNow.length > 0 && planRowsShown}
        {(since !== null || stepsNow.length > 0) && <Text> </Text>}
        <Text bold>Agents</Text>
        {agents.length === 0 ? <Text dimColor> none yet</Text> : shownAgents.map(agentRow)}
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
