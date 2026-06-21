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
| `Esc`         | Interrupt the running session / **deny** a pending permission / close the model picker |
| `y`           | Approve the pending permission request                         |
| `n`           | Deny the pending permission request                            |
| `↑ ↓` `Enter` | Navigate + confirm inside the `/model` picker                  |
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

Unknown `/foo` renders an "unknown command — try /help" notice.

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

## Layout

```
┌ SessionHeader ─ model · mode · status · cost ┐
│ StreamView ─ scrollable transcript            │
│   assistant deltas, tool calls, tool results  │
│ PermissionPrompt ─ shown when approval needed │
│ InputBox ─ multi-line prompt                  │
│ FooterHints ─ keybinding hints                │
└───────────────────────────────────────────────┘
```

## Architecture

- `src/index.ts` — entry: resolves config, builds `SessionManager`, mounts `<App>`.
- `src/App.tsx` — layout + global keybindings.
- `src/useSession.ts` — the single engine-subscription hook; folds the event
  stream into a view via `session-reducer.ts` and exposes typed command dispatchers.
- `src/session-reducer.ts` — pure reducer; replicates the CLI's partial-delta dedup.
- `src/components/` — `SessionHeader`, `StreamView`, `InputBox`, `PermissionPrompt`,
  `ModelPicker`, `FooterHints`.
- `src/commands/` — the slash-command surface: `parse.ts` (`parseSlash`),
  `registry.ts` (the typed command table + `runCommand`), `doctor.ts`, `types.ts`
  (`CommandContext`). Slash handling lives entirely here; the engine is untouched.
