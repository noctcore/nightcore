# @nightcore/tui

Nightcore's interactive terminal surface — an OpenTUI + React view over the
`@nightcore/engine` event stream. The surface speaks **only** `SurfaceCommand` /
`NightcoreEvent`; it never imports the Claude Agent SDK (enforced by eslint).

## Run

Requires a TTY and your local Claude CLI credentials (`~/.claude`). It cannot run
in a non-interactive shell.

```bash
bun run apps/tui/src/index.ts
# or, from the repo root:
bun run tui
```

## Keybindings

| Key           | Action                                                          |
| ------------- | -------------------------------------------------------------- |
| `Enter`       | Submit the prompt (starts a session, sends follow-up, or runs a `/command`) |
| `Shift+Enter` | Insert a newline (multi-line input)                            |
| `Shift+Tab`   | Toggle permission mode: **plan** (read-only) ↔ **build** (acceptEdits) |
| `Esc`         | Close the autocomplete / interrupt the running session / **deny** a pending permission / close the model picker |
| `y`           | Approve the pending permission request                         |
| `n`           | Deny the pending permission request                            |
| `↑ ↓` `Enter` | Navigate + confirm inside the `/model` picker                  |
| `Tab`         | Complete the highlighted command when the slash autocomplete is open |
| `↑ ↓`         | Move the highlight in the slash autocomplete                   |
| `Enter`       | Run the highlighted command when the slash autocomplete is open |
| `Ctrl+C`      | Quit                                                            |

### Enter vs Shift+Enter

The prompt box is an OpenTUI `<textarea>`. Its defaults bind plain `Enter` to
the `newline` action and only `Alt+Enter` to `submit` — the opposite of what you
want. We override the textarea's `keyBindings` so plain `return`/`kpenter` map to
the **`submit`** action and `Shift+`(`return`/`kpenter`) map to **`newline`**.
Custom bindings are merged over the defaults by a `name:ctrl:shift:meta:super`
key, so the `submit` binding _replaces_ the default `newline` for plain Enter and
the textarea consumes the key without also inserting a newline.

## Slash commands

When the prompt buffer starts with `/` it is treated as a command, not a prompt.
Commands are surface-only — the engine never sees them.

| Command   | Action                                                                 |
| --------- | ---------------------------------------------------------------------- |
| `/help`   | List commands + keybindings (rendered as a system block)               |
| `/clear`  | Clear the transcript (keeps the live session)                          |
| `/model`  | Open a picker for the dynamic model list; if the model supports effort, pick a reasoning effort too |
| `/doctor` | Diagnostics: Claude CLI present/authed, config + resolved paths, default model/effort/permission mode, SDK version, active session count |
| `/quit`   | Exit                                                                   |

### Autocomplete

While the buffer is a bare command name — it starts with `/` and has no space
yet (`/mo`, `/`) — a dropdown floats **above** the input listing matching
commands: the local registry above, then the live session's SDK-native commands
(labelled `(session command)`). Once you type a space (args) or the buffer stops
starting with `/`, the dropdown collapses.

| Key     | Action                                              |
| ------- | --------------------------------------------------- |
| `↑ ↓`   | Move the highlight (wraps)                           |
| `Tab`   | Complete the highlighted command into the buffer (`/name ` — stays open for args) |
| `Enter` | Run the highlighted command                          |
| `Esc`   | Dismiss (clears the `/…` buffer)                     |

**How the keys are routed.** OpenTUI's `useKeyboard` taps the raw key stream
(`renderer.keyInput`) and fires for every key regardless of focus, while the
focused `<textarea>` separately runs its own `handleKeyPress`. So `App`'s global
handler always sees `↑/↓/Tab/Enter`. `Tab` is never a `TextareaAction`, so the
textarea never consumes it. `↑/↓` move the textarea cursor (a no-op in a one-line
`/command`) **and** move the dropdown highlight. The one key that would conflict
is `Enter`: by default it's rebound to the textarea's `submit` action, which would
submit the raw buffer. So while the autocomplete is open the InputBox drops the
`return`/`kpenter` → `submit` bindings (`suppressNav`); with no matching action the
textarea returns `false` for `Enter` (it's a control char, not printable text) and
the key falls through to `App`, which runs the highlighted command. Completion
writes the buffer via the textarea's `setText` through an imperative
`InputBoxHandle` ref.

### SDK-command bridge

`session-ready` carries the session's own `slashCommands` (from `.claude/commands`,
plugins, and builtins) and `skills`. The command runner resolves a `/name` in this
order:

1. A **local** registry command (`/help`, `/model`, …) → run it (surface-only).
2. Otherwise, if `name` is one of the session's SDK `slashCommands` — **or** we
   have no SDK list yet (pre-`session-ready`) — forward the literal `/name args`
   to the engine as a normal prompt (`start-session` when idle/terminal, else
   `send-input`). The SDK interprets it.
3. Only if it is neither local nor SDK-known do we render the
   "unknown command — try /help" notice.

`/help` lists both groups: local commands, then **session commands (forwarded to
the engine)**, then any discovered **skills**.

`/model` is two steps: choose a model, then (only if the model
`supportsEffort`) choose from _its_ `supportedEffortLevels` or `adaptive`. The
model change is applied live via `set-model` if a session is running; the **effort
choice applies to the next session** (the SDK has no live effort setter), and the
picker footer says so.

## Transcript

User and assistant turns render as distinct blocks: the operator's own prompt is
echoed with a blue `▌ you` gutter, the assistant answer with a green `▌` gutter,
and tool calls/results nest under the answer (`╰ ⚙ tool` → `↳ result`). A blank
line separates turns so a conversation reads as alternating blocks. A
`permission-required` whose `risk === 'dangerous'` is badged with a red
**DANGEROUS** accent.

## Task panel

A `task-updated` event (folded from the SDK's `task_started` / `task_updated` /
`task_progress` system messages) upserts a `TaskView` into `view.tasks`, keyed by
`taskId` — **never by index**, so a status-only patch keeps the description an
earlier event set. The tasks reset on every `session-started`.

`TaskPanel` renders the live set as a compact checklist between the transcript and
the input, with a status glyph (`pending ○`, `running ◐`, `completed ✓`,
`failed ✗`, `killed ⊘`, `paused ‖`), the description, a `[subagentType]` badge when
present, and an optional summary. **Ambient** tasks (`ambient: true`) are dimmed.
The panel only mounts when there is at least one **non-ambient** task, so an empty
or all-ambient set leaves the layout clean.

## Session stats

`session-completed` carries `durationMs` and a `usage` token breakdown. The header
shows them next to cost once a session finishes: duration (`3.2s`, `1m32s`) and
tokens (`↑12.3k ↓4.5k`, plus `(+Nk cache)` only when cache reads are non-zero). The
completion notice in the transcript echoes the same compact stats. Formatting lives
in `src/format.ts` so the header and the notice read identically.

## Layout

```
┌ SessionHeader ─ model · mode · status · cost · duration · tokens ┐
│ StreamView ─ scrollable transcript                                │
│   assistant deltas, tool calls, tool results                      │
│ TaskPanel ─ live task checklist (when non-ambient tasks exist)    │
│ PermissionPrompt ─ shown when approval needed                     │
│ CommandPalette ─ slash autocomplete (above the input)             │
│ InputBox ─ multi-line prompt                                      │
│ FooterHints ─ keybinding hints                                    │
└───────────────────────────────────────────────────────────────────┘
```

## Architecture

- `src/index.ts` — entry: resolves config, builds `SessionManager`, mounts `<App>`.
- `src/App.tsx` — layout + global keybindings.
- `src/useSession.ts` — the single engine-subscription hook; folds the event
  stream into a view via `session-reducer.ts` and exposes typed command dispatchers.
- `src/session-reducer.ts` — pure reducer; replicates the CLI's partial-delta dedup.
- `src/format.ts` — shared compaction helpers (`formatDuration`, `formatTokens`,
  `formatUsage`) used by the header stats and the completion notice.
- `src/components/` — `SessionHeader`, `StreamView`, `TaskPanel`, `CommandPalette`,
  `InputBox`, `PermissionPrompt`, `ModelPicker`, `FooterHints`.
- `src/commands/` — the slash-command surface: `parse.ts` (`parseSlash`),
  `registry.ts` (the typed command table + `runCommand` with the SDK-command
  bridge), `palette.ts` (`buildPalette`/`matchPalette` for autocomplete + `/help`),
  `doctor.ts`, `types.ts` (`CommandContext`, incl. `forwardPrompt`). Slash handling
  lives entirely here; the engine is touched only via `forwardPrompt`.
