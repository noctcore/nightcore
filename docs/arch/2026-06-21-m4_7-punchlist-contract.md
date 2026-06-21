# M4.7 Contract — Dogfood Punch-List (perms, tool visibility, transcript, markdown, model/effort)

**Date:** 2026-06-21 · **Status:** FROZEN (orchestrator-owned). Serde-additive. Grounded in `docs/research/2026-06-21-m4_7-punchlist-audit.md`.

**Locked decisions (user):** **(1) native SDK tools only** — drop the custom `mcp__nightcore__*` tool surface; the agent uses the SDK's native Read/Write/Edit/Bash/Grep/Glob (the Claude-Code mental model). **(2) Bypass by default** — new tasks run with `bypassPermissions` (no approval prompts), with a per-task override to re-enable prompting.

Reference (read-only): AutoMaker sets `permissionMode:'bypassPermissions' + allowDangerouslySkipPermissions:true` (`automaker/.../sdk-options.js:179-180`); SDK contract at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1647-1660`.

---

## A. Permissions + tool surface — contracts + engine + Rust core (the dogfood unblock, P0)

### A1. Add a `bypass` permission mode end-to-end
- **contracts** `config.ts`: extend `PermissionModeSchema` to include the SDK's `bypassPermissions` (and `dontAsk` if not already present) so the engine can receive it.
- **Rust** `settings.rs`: the persisted UI modes become **`bypass` | `auto-accept` | `ask` | `plan`**. Map: `bypass→bypassPermissions`, `auto-accept→acceptEdits`, `ask→default`, `plan→plan`. **Default `permission_mode` = `bypass`** (global + per-project). DELETE the test that pins bypass→default (that fail-closed assumption is intentionally removed); add a test pinning the new mapping incl. `bypass`.
- **engine** `session-runner.ts`: when the resolved `permissionMode === 'bypassPermissions'`, set `allowDangerouslySkipPermissions: true` in the SDK `Options` (required by the SDK or bypass is ignored). Never log/persist secrets; this flag is config, fine to log at debug.
- Fail-safe note: bypass is the user's explicit choice for an autonomous studio; it is NOT silently inferred — it's the configured default they can change.

### A2. Native tools only — drop the custom MCP surface
- **engine** `session-runner.ts` baseOptions: stop registering the in-process `mcp__nightcore__*` server (`mcpServers: this.registry.mcpServers()` → remove/empty). Keep `agents: nightcoreAgents`. The SDK's native tools remain available without it.
- `packages/tools` + `packages/mcp` become unused by the live path — **do NOT delete them this milestone** (leave for a later removal pass); just stop wiring the server into sessions. Keep their tests green or skip via the unwiring (don't break the build).
- Reassess `settingSources`: today `['user', …]` loads the user's personal `~/.claude` permission rules/skills, which leak nondeterministically into runs. Prefer Nightcore-controlled permissions over the user's env. If dropping/narrowing `settingSources` is clean (note that `nightcoreAgents` is passed via `Options.agents`, not settingSources, so it survives), do it; if it risks losing needed behavior, leave it and document why. Either way, **Nightcore's permission policy — not the user's ~/.claude — must govern a run.**

### A3. Sane risk classification for non-bypass modes
- `tool-registry.ts` `riskOf()` returns `undefined` for native tools → `permission-layer.ts` folds `undefined` into `dangerous` (prompts in `default`, auto-denies in `dontAsk`). Fix: classify native **read-only** tools (`Read`, `Grep`, `Glob`, `Bash` git-status-class — at least `Read/Grep/Glob`) as **safe** so they auto-allow in `ask`/`auto-accept`, while writes/edits/shell stay prompt-worthy. This makes the non-bypass modes usable instead of prompt-storms. (In `bypass` nothing prompts anyway — this is for the other modes.)

### A4. Per-task permission override
- **Rust** `Task` gains `permission_mode: Option<String>` (serde-additive, `None` = inherit the resolved default). `TaskPatch` + create accept it. The launch path (`resolve_permission_mode`) prefers the task override → project default → global default. UI in §F.
- This is what lets a single task opt OUT of global bypass (e.g. set it to `plan` or `ask`).

## B. Tool-call visibility — web (P1)
The tool `input` is ALREADY on the wire (`sdk-adapter.ts:281-286`, `events.ts:96-103`) — the web drops it. Fix in `apps/web`:
- Carry `input` through `session-stream.ts` `ToolLine` (currently `{id, toolName}` → add `input`).
- Render a concise summary on each tool line in TaskDetail (the file path for Read/Edit/Write, pattern for Grep/Glob, command for Bash) instead of just the tool name. Promote the existing `summarizeInput` (`PermissionPrompt.hooks.ts:5-16`) to a shared util (`lib/` or `components/ui`) and reuse it both places.
- Keep the secrets discipline for LOGS (unchanged) — this is UI only, which is fine and desired.

## C. Transcript persistence — Rust core + web (P1)
Today the transcript is live-only (`nc:session` → web `useState` map, lost on reload). Persist it:
- **Rust core**: append each task's session events to a per-task transcript file (JSONL) under the project's `.nightcore/tasks/<id>/transcript.jsonl` (or alongside the task JSON). Append on the same path that emits `nc:session`. Keep it bounded/secret-safe (tool inputs MAY be persisted here since it's the user's local transcript, but never tokens).
- Command `read_transcript(taskId) -> Vec<event>` (or a tail). Web reseeds the stream view from it on mount / when a task is opened, so reload/HMR no longer blanks the transcript.
- Mirror the M4.5 logging discipline: this is local persistence, not telemetry.

## D. Markdown rendering — shared web primitive (P2)
- Add a reusable `<Markdown>` primitive in `apps/web/src/components/ui/` (pick a lightweight, well-maintained renderer; sanitize). Cosmic-dark styled (code blocks, lists, headings, inline code).
- Consume it where assistant/markdown text renders raw today: the stream/assistant turns, the **ReviewPanel** verdict (`ReviewPanel.tsx:35-37`), and the plan text. It's a shared `ui/**` primitive (escape-hatch folder — no folder-per-component required, but still typed + a story/test).

## E. Per-task model + reasoning effort — Rust core + contracts wire + web (P2)
- **Rust** `Task` gains `effort: Option<String>` (serde-additive; `model` already exists). `TaskPatch` + create accept it.
- **Thread effort to the SDK**: the Rust `start_session` payload currently omits effort (`provider.rs:272-288`, `coordinator.rs` launch). Add `effort` to the start-session command JSON; the engine already threads `command.effort` (`session-manager.ts:168`) — just send it. Send the task's `model` + `effort` on launch (manual run + auto-loop + reviewer/fix dispatch as appropriate; the reviewer keeps its own model policy).
- **Web** §F picker.

## F. Web pickers (P1–P2)
All new components obey folder-per-component + cosmic-dark stories + tests; `lib/bridge.ts` the sole Tauri seam.
- **Permission-mode picker** per task (bypass/auto-accept/ask/plan; default = inherit) in TaskDetail (editable pre-run) and optionally NewTaskForm. Mirror `Task.permissionMode` + patch.
- **Model + effort picker** per task in TaskDetail/NewTaskForm. Model list: a static set of the known Claude ids is acceptable this milestone (dynamic `listModels()` is a deferred stretch — see §G); effort = the SDK effort levels. Mirror `Task.model`/`Task.effort` + patch + create.
- **Transcript view** consumes `read_transcript` to reseed; tool lines show args (§B); assistant text renders via `<Markdown>` (§D).
- New bridge fns: `readTranscript`; `permissionMode`/`model`/`effort` on create/patch.

## G. Out of scope / deferred
- Dynamic model list via engine `listModels()`/`supportedModels()` + per-model effort gating (F5.3) — static list this milestone.
- Deleting `packages/tools`/`packages/mcp` (unwire now, remove later).
- The View-changes diff dialog from M4.6 (needs a backend diff-read command).

## H. Guardrails
- Serde-additive; legacy tasks load with `permission_mode=None`, `effort=None`, `model=None` (all inherit). Extend the pinning test.
- Keep all suites green (125 cargo / 197 web / 39 plugin / 219 node) + new tests. No secret/token ever logged or persisted; transcript persistence is local-only.
- Bypass is powerful: main-mode tasks run in the project tree with no prompts — that's the user's explicit choice. Still: no force/destructive git beyond what the agent's own tools do; the gate + gauntlet still apply.
