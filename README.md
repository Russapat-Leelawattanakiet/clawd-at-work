# clawd-at-work

A Claude Code mod that opens a **"Claude at work"** side pane in the terminal, so you can see at a glance what Claude
is doing and how far along it is.

```
 ▐▛███▜▌ ✎     editing
▝▜█████▛▘      0:42
  ▘▘ ▝▝        1 agent · 1 skill

 Claude   ━━━━━━━━━━━━━━▛█▜──────────  52%  0:42
          Editing register.tsx  step 6 · 9 tools
 Plan     2/4 steps done
  ✓ Read the code
  ✓ Write the README
  ◐ Run the tests
    ━━━━━━━━━▛█▜─────────────  41%  0:12
  ○ Commit
 Recent   9 actions
  ✓ Run claude plugin test .              1.6s
  ▤ Read register.test.tsx                0.1s
  ✎ Edit register.tsx
 Files    ✎ register.tsx  ✎ README.md  ◦ index.d.ts

Agents
▸ ◐ Explore  find the config loader
    ━━━━━━━━━━━━▜█▛─────────  48%  0:21 · 7 tools
Skills
 ✓ plugin-authoring  0:03
```

## What it shows

- **Clawd, the mascot.** It bobs, waves and blinks while Claude works, and rests with its eyes shut when idle. It holds
  a prop for the kind of work Claude is doing: thought dots while thinking, a page while reading, a magnifier while
  searching, a pen while editing, `>_` while running a command. The word beside it says the same (`reading`,
  `editing`, `running a command`, ...). It reads **waiting for you** while Claude asks you a question or waits for you
  to approve a plan, shows a red `!` and **hit a snag** for a few seconds when a tool fails, and cheers with sparkles
  (**done!**) when a turn ends. Below the word are the turn's elapsed time and how many agents and skills ran.
- **Usage.** How much of your plan's limits you've used: the 5-hour **Session** window and the 7-day **Week** window,
  each with a bar (yellow from 70%, red from 90%) and how long until it resets. Below them, the tokens used this
  session and this week, and the session's cost. The week's token count covers only sessions that have this mod
  installed on this computer, and it starts over when the weekly window resets. The limit bars appear only when you're
  logged in with a Claude subscription, after Claude's first reply.
- **Claude bar.** Progress of the current turn. A mini Clawd runs at the head of the bar. Below it is what Claude is
  doing right now, in plain words: thinking, writing a reply, or the action and its target (for example
  `Editing register.tsx`, `Searching for usage`), plus step and tool counts.
- **Done.** When a turn ends, the Claude bar gives way to a one-line summary that stays until your next prompt, such as
  `Done ✓ 2:14 · 2 files edited · 12 tools`, with any failed calls counted in red (`Stopped` if you interrupted it, `Failed` if an API error or a refusal
  ended it).
- **Plan.** The mod gives Claude a `plan` tool (`mcp__clawd-at-work__plan`) and a short note in its system prompt asking
  it to list its steps for any multi-step task. Each step's title gets the full width of the pane, the step in progress
  has its own bar and time beneath it, and the Claude bar becomes the real progress through the plan. Claude Code's own `TodoWrite` list drives the plan too.
- **Steps (auto).** When Claude has not declared a plan, the pane builds steps from what it actually does (each tool
  call, each stretch of thinking), and repeats of the same action merge into one counted step.
- **Recent.** Under a declared plan, the last few actions Claude took, each with an icon for its kind and how long it
  took; a failed one is marked with a red ✗.
- **Files.** The files Claude has edited (`✎`, first) and read (`◦`) since your last prompt, with `+N` for the ones that
  don't fit. Files a subagent edits are listed too; files it only reads are not.
- **Agents.** Every subagent Claude starts, newest first, each in its own color, with an estimated progress bar, run
  time and tool count. Click a row to open a dropdown of its latest tool calls and how long each took.
- **Skills.** Every skill Claude loads (through the Skill tool or typed as `/name`), with its status and time.
- **Sessions.** Other Claude Code sessions working in the same project at the same time (background sessions from
  `claude --bg`, other terminals, worktrees of the same repository), each with what you last asked it, whether it is
  working, waiting for you, done, failed or idle, its percent, and what it is doing right now. Sessions waiting for you
  and working ones come first. A session that closes leaves the list, and one that stops reporting drops off within
  about a minute. Each session publishes its status in the mod's store, a file shared by every session on this
  computer.

A permission prompt (Claude asking to run a command) still reads as the action itself, not "waiting for you": Claude
Code tells the mod when the dialog opens but not when you answer it.

Progress estimates are learned: the mod remembers how long each agent type, turn and step usually takes (kept across
sessions), so the bars get more accurate the more you use it. An estimate stays below 100% until the work really ends.

Each new prompt you send clears finished agents, skills, the plan, Recent, Files and the Done line, so every bar starts
over. Agents still running carry on.

## Requirements

- [Claude Code](https://claude.com/claude-code) in a terminal (Windows, macOS or Linux).
- The pane docks beside the chat in the fullscreen terminal layout. It opens by itself when the window is wide enough
  (about 110–144 columns); in a narrower window it waits until you widen it or run `/clawd-at-work`.
- This repository is **private**: to install, you need read access to it on GitHub, and your computer needs a git
  credential for github.com (an SSH key, or `gh auth login` followed by `gh auth setup-git`). The install never asks
  for a password.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install clawd-at-work --marketplace Russapat-Leelawattanakiet/clawd-at-work
```

Answer `y` to **Add marketplace?**, then press Enter to pick the **user** scope (installs it for all your sessions).
You should see `Installed clawd-at-work. Plugin is now active.` The pane opens right away; no restart needed.

From a shell instead:

```
claude plugin install clawd-at-work --marketplace Russapat-Leelawattanakiet/clawd-at-work
```

In the Claude desktop app (where `/plugin` does not run): click **+** next to the prompt box, then **Plugins** →
**Add marketplace** with `Russapat-Leelawattanakiet/clawd-at-work`, then **Add plugin**.

## Use

There is nothing to set up: the pane opens when a session starts and updates by itself.

| To | Do |
| --- | --- |
| Reopen the pane after closing it | Type `/clawd-at-work` |
| See an agent's tool calls | Click its row in **Agents** (click again to close) |
| Get a plan bar for a task | Just ask for a multi-step task; Claude calls the `plan` tool itself |

## Update and uninstall

From a shell:

```
claude plugin update clawd-at-work
claude plugin uninstall clawd-at-work
```

Or type `/plugin` in a session and manage it from the menu.

## Develop

Run Claude Code with the mod loaded straight from a clone of this repository:

```
claude --plugin-dir path/to/clawd-at-work
```

Check and test it:

```
claude plugin validate .
claude plugin test .
```

Files:

- `hooks/register.tsx`: the mod (hooks, pane drawing, the `plan` tool)
- `hooks/register.test.tsx`: tests
- `hooks/probe*.test.tsx`: tests from the requirement test rounds, one file per round
- `REQUIREMENTS.md`: what the pane must do, with IDs the tests refer to
- `types/index.d.ts`: the types of the values the mod keeps in session state
- `.claude-plugin/plugin.json`: manifest; `.claude-plugin/marketplace.json`: makes this repo installable

## License

MIT, see [LICENSE](LICENSE).
