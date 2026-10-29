# clawd-at-work: user requirements

Who it's for: someone who watches Claude Code work in a terminal and wants to know, at a glance, **what Claude is
doing, how far along it is, and whether anything went wrong**, without reading the transcript.

Each requirement has an ID so test reports can point at it. "Narrow" means a 40-column pane body, the default.

## 1. Glanceable status

- **R1.1** At any moment the pane shows whether Claude is working, waiting for the person, finished, or idle.
- **R1.2** While Claude works, one line says in plain words what it is doing right now (`Reading notes.md`,
  `Running npm test`, `thinking…`), not tool names or raw JSON.
- **R1.3** Clawd's prop and the word beside it match the kind of work (think, read, search, edit, run, web, agent,
  ask). It shows "waiting for you" while Claude waits on the person, "hit a snag" for a few seconds after a failed
  call, and cheers when a turn ends normally (not after an error, refusal or interruption).
- **R1.4** When a turn ends, a Done line sums it up (time, files edited, tool count, failed calls) until the next prompt.
  It reads `Stopped` if the person interrupted and `Failed` if an API error or refusal ended it.

  *Known limit:* a **permission prompt** (Claude asking to run a command) still reads as the action itself, not
  "waiting for you". The mod API says when the dialog opens (`classic.PermissionRequest`, a `tool.check` verdict of
  `ask`) but not when the person answers it or when the approved tool starts, so a waiting state would stay on while
  the approved command runs. Checked in test rounds 1 and 2.

## 2. Readable text in a narrow pane

- **R2.1** Every line fits the pane width; nothing wraps into the next line or overflows.
- **R2.2** Shell commands show the work, not the plumbing: a leading change of folder (`cd`, `Set-Location`, `pushd`)
  is dropped, and long paths inside a command are cut to their last name. Short paths, URLs, globs and flags stay.
- **R2.3** File targets show the file's name, not its full path.
- **R2.4** Plan and step titles get the full width of the pane (about 35 characters when narrow) before they are cut
  with `…`.
- **R2.5** Text cut to fit always ends in `…`, never mid-character or with a broken surrogate pair.
- **R2.6** Multi-line inputs (commands, prompts) show only their first line.

## 3. Progress

- **R3.1** When Claude declares a plan (the `plan` tool or `TodoWrite`), each step shows ✓ done, ○ pending, or a
  spinner while active, and the active step has a bar, percent and elapsed time. The Claude bar is the plan's progress.
- **R3.2** Without a plan, the pane builds steps from what Claude does, merging repeats of the same action (`×2`).
- **R3.3** Progress estimates never reach 100% until the work really ends, and learn typical times across sessions.
- **R3.4** Under a declared plan, a Recent list shows the latest actions with their time; failed ones are marked ✗.

## 4. Agents and skills

- **R4.1** Every subagent shows a row: its type, task, color, estimated bar, time and tool count. Running agents are
  never hidden for space; finished ones that don't fit are counted.
- **R4.2** Clicking an agent row opens a list of its latest tool calls, with the same readable targets as R2.
- **R4.3** Every skill Claude loads is listed with status and time.

## 5. Files and usage

- **R5.1** Files edited (first) and read since the last prompt are listed once each, even when one file is written two
  ways on Windows (case, slashes). A subagent's edits count; its reads don't.
- **R5.2** Usage shows the Session and Week limit bars (yellow from 70%, red from 90%) with time to reset, and tokens
  for the session and week.

## 6. Lifecycle

- **R6.1** A new prompt clears finished agents, skills, the plan, auto steps, Recent, Files and the Done line. Running
  agents carry on.
- **R6.2** The pane opens by itself when the window is wide enough, and `/clawd-at-work` reopens it.
- **R6.3** Parallel sessions in one project stay visible. When the person runs other Claude Code sessions in the same
  project at the same time (background sessions started with `claude --bg`, sessions in other terminals or worktrees),
  the pane in each session lists the others under **Sessions**: each one's name, what it is doing right now, its
  progress and whether it is working, waiting for the person, done or failed. A session that ends or stops reporting
  drops off the list within about a minute. Each session's own sections (Claude bar, plan, agents, files, Done line)
  still show only its own work; only learned typical times, the week's token count and the Sessions list are shared.

## 7. Safety and robustness

- **R7.1** The mod never changes what a tool, skill or agent does, never runs one twice, and never blocks one, even
  when its own bookkeeping fails.
- **R7.2** Odd input never crashes the pane: missing or non-string fields, empty strings, very long text, unknown
  tools, unknown statuses, unicode, a plan with zero or more than 20 steps.
- **R7.3** The pane stays cheap: it redraws at most ~4 times a second and keeps bounded lists (runs, calls, feed,
  files, steps).
- **R7.4** Works on Windows, macOS and Linux paths and shells (Bash and PowerShell).
