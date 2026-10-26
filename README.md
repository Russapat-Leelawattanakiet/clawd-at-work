# clawd-at-work

A Claude Code mod that opens a **"Claude at work"** side pane in the terminal, so you can see at a glance what Claude
is doing and how far along it is.

```
 ▐▛███▜▌    working
▝▜█████▛▘   0:42
  ▘▘ ▝▝     1 agent · 1 skill

 Claude   ━━━━━━━━━━━━━━▛█▜──────────  52%  0:42
          Edit  register.tsx  step 6 · 9 tools
 Plan     2/4 steps done
  ✓ Read the code         ━━━━━━━━━━━━━━━━━━ 100%
  ✓ Write the README      ━━━━━━━━━━━━━━━━━━ 100%
  ◐ Run the tests         ━━━━━━━▛█▜────────  41%
  ○ Commit                ──────────────────   0%

Agents
▸ ◐ Explore  find the config loader
    ━━━━━━━━━━━━▜█▛─────────  48%  0:21 · 7 tools
Skills
 ✓ plugin-authoring  0:03
```

## What it shows

- **Clawd, the mascot.** It bobs, waves and blinks while Claude works, and rests with its eyes shut when idle. Beside it
  are the state (`working`, `agents working`, `resting`), the turn's elapsed time, and how many agents and skills ran.
- **Claude bar.** Progress of the current turn. A mini Clawd runs at the head of the bar. Below it is what Claude is
  doing right now: thinking, writing a reply, or the tool and its target (for example `Edit register.tsx`), plus step and
  tool counts.
- **Plan.** The mod gives Claude a `plan` tool (`mcp__clawd-at-work__plan`) and a short note in its system prompt asking
  it to list its steps for any multi-step task. Each step gets its own bar, and the Claude bar becomes the real progress
  through the plan. Claude Code's own `TodoWrite` list drives the plan too.
- **Steps (auto).** When Claude has not declared a plan, the pane builds steps from what it actually does (each tool
  call, each stretch of thinking), and repeats of the same action merge into one counted step.
- **Agents.** Every subagent Claude starts, newest first, each in its own color, with an estimated progress bar, run
  time and tool count. Click a row to open a dropdown of its latest tool calls and how long each took.
- **Skills.** Every skill Claude loads, with its status and time.

Progress estimates are learned: the mod remembers how long each agent type, turn and step usually takes (kept across
sessions), so the bars get more accurate the more you use it. An estimate stays below 100% until the work really ends.

Each new prompt you send clears finished agents, skills and the plan, so every bar starts over. Agents still running
carry on.

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
- `types/index.d.ts`: the types of the values the mod keeps in session state
- `.claude-plugin/plugin.json`: manifest; `.claude-plugin/marketplace.json`: makes this repo installable

## License

MIT, see [LICENSE](LICENSE).
