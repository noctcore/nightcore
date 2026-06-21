# M4.7 — Dogfood Punch-List Audit

> Research only. No code written. Read-only investigation of the Nightcore
> tiers (Rust core · engine · sidecar · contracts · web) plus the AutoMaker
> predecessor for UX reference. Every claim is grounded in `file:line`.
>
> **Owning tiers** used in fixes below: `Rust core` =
> `apps/desktop/src-tauri/src`, `engine` = `packages/engine`, `sidecar` =
> `apps/sidecar`, `contracts` = `packages/contracts`, `web` = `apps/web`.

---

## TL;DR

The dogfood pain is one root architectural decision plus four missing UI/persistence affordances:

1. **Permission model is fail-closed by construction and there is no escape hatch.** The Rust→engine path can only ever send `acceptEdits` / `plan` / `default`; `bypassPermissions` and `dontAsk` are *deliberately* mapped to `default` (`settings.rs:200-203`), and `allowDangerouslySkipPermissions` (required by the SDK for bypass) appears **nowhere** in the repo. Worse, **native `Bash`/git tools have no Nightcore risk descriptor → `riskOf()` returns `undefined` → the PermissionLayer treats them as `dangerous` → they always prompt and, under `dontAsk`/review, are auto-**denied** (`permission-layer.ts:87-92`, `tool-registry.ts:56-64`). Meanwhile the in-process MCP tools *do* carry risk metadata so they at least prompt cleanly. That asymmetry is exactly what the user hit. AutoMaker's autonomous mode does the opposite and just works: `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true` (`automaker .../sdk-options.js:179-180`, `claude-provider.js:180-181`).
2. **Tool args are already on the wire — the UI just throws them away.** `tool-use-requested` carries `input` (`sdk-adapter.ts:281-286`, `events.ts:96-103`) but the renderer prints only `tool.toolName` (`TaskDetail.tsx:155-172`) and `session-stream.ts` only stores `{id, toolName}` (drops `input`).
3. **No transcript persistence by Nightcore.** Events are streamed live to the webview (`sidecar.rs` emit `nc:session`) and folded into an in-memory React `useState` map that resets on reload (`AppShell.hooks.ts:264`). `SessionStore` persists *metadata only* and explicitly declines transcripts (`packages/storage/src/index.ts:10`).
4. **No markdown.** Zero markdown deps; assistant text and review verdict render raw in `<pre>` (`TaskDetail.tsx:174-194`, `ReviewPanel.tsx:35-37`).
5. **Per-task model is half-wired; per-task effort is not wired at all.** `Task` has `model` but no `effort` (`task.rs:78`, no effort field); `TaskPatch` likewise (`task.rs:173-182`). `StartSessionCommand` *carries* `effort` (`commands.ts:28`) and the engine threads it (`session-manager.ts:168`), but the Rust `start_session` signature/payload omits effort entirely (`provider.rs:272-288`, `coordinator.rs:388-399`). No UI picks model or effort per task (`NewTaskForm` has only title/description/kind).

---

## Q1 — Permission model + a bypass / "dangerous" mode (P0)

### Current state

**The five permission modes the SDK supports** (`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1995`):
```
'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto'
```
`bypassPermissions` **requires** `allowDangerouslySkipPermissions: true` (`sdk.d.ts:1647-1660`):
> `'bypassPermissions'` - Bypass all permission checks (requires `allowDangerouslySkipPermissions`)
> Must be set to `true` when using `permissionMode: 'bypassPermissions'`.

**Contracts already model all six modes** — `PermissionModeSchema` includes `bypassPermissions` and `dontAsk` (`contracts/src/config.ts:11-19`). So the *vocabulary* exists; the wiring does not.

**The Rust settings can only ever emit three of them.** `settings.rs:195-203`:
```rust
pub fn sdk_permission_mode(raw: &str) -> String {
    match raw {
        "auto-accept" => "acceptEdits",
        "plan"        => "plan",
        "ask"         => "default",
        _             => "default",   // fail-closed
    }
}
```
The three UI-facing modes are `auto-accept | plan | ask` (`settings.rs:29` doc, default `auto-accept` at `settings.rs:46`). A test even *pins* the fail-closed behavior: `assert_eq!(sdk_permission_mode("bypassPermissions"), "default")` (`settings.rs:309`). So a user literally cannot reach bypass through settings.

**`allowDangerouslySkipPermissions` is never set anywhere.** Grep across engine + sidecar + Rust core returns nothing. `SessionRunner.run()` builds `Options` with `permissionMode`, `canUseTool`, `mcpServers`, `hooks`, effort, kind overrides — but no `allowDangerouslySkipPermissions` (`session-runner.ts:118-145`). Therefore even if `bypassPermissions` reached the SDK, the SDK would reject it.

### Why native git/Bash were DENIED while MCP tools only prompted (root cause)

Two layers stack here, and the interaction is the bug:

1. **The harness `PermissionLayer.canUseTool`** (`permission-layer.ts:74-99`). Resolution order:
   - explicit `deny` list → deny;
   - `risk === 'dangerous' || risk === undefined` **and not in `allow` list → prompt** (`:87-92`);
   - in `allow` list → allow;
   - else → prompt.

2. **`riskOf(toolName)`** only knows tools that have a Nightcore *descriptor* (`tool-registry.ts:50-64`). The descriptor catalog is the in-process MCP tools (`mcp__nightcore__read_file`, `…__run_command`, etc.) plus external MCP placeholders — see `packages/tools/src/index.ts:57-128`. **Native SDK tools (`Bash`, `Read`, `Write`, `Edit`, `Agent`, native `git`) have no descriptor**, so `riskOf()` returns `undefined`, which `permission-layer.ts:90` explicitly folds into `dangerous`.

So:
- `mcp__nightcore__read_file` → `risk: 'safe'` (`index.ts:72`) → not dangerous → if allow-listed, auto-allow; otherwise **prompt**.
- `mcp__nightcore__run_command` → `risk: 'dangerous'` (`index.ts:128`) → **prompt** (the user saw this).
- Native `Bash` / native `git` → `risk: undefined` → treated `dangerous` → **prompt** in `default` mode, but **auto-DENIED** under the `review` kind (`permissionMode: 'dontAsk'`, `kind-presets.ts:62-71`) because `dontAsk` "Don't prompt for permissions, **deny if not pre-approved**" (`sdk.d.ts:1649`). The SDK's `dontAsk` short-circuits to deny before `canUseTool` even runs for unapproved tools, and the harness has no allow-list entry for native tools. That is the "native git/Bash got DENIED, forcing the agent onto MCP tools + subagents" symptom.

**Default policy lists are empty.** `PermissionPolicySchema` defaults `allow: []`, `deny: []`, `mode: 'default'` (`contracts/src/config.ts` PermissionPolicy block) and `ConfigSchema.permissions.prefault({})` (same file). So with the shipped defaults nothing is pre-allowed → everything dangerous/unknown prompts (or denies under dontAsk). That is *exactly* the "approve every single tool call" experience.

### Why BOTH native SDK tools AND custom `mcp__nightcore__` tools are present (dual surface)

`baseOptions()` (`session-runner.ts:200-237`) sets:
- `settingSources: this.cfg.settingSources` — defaults to `['user','project','local']` (`contracts/src/config.ts` `settingSources` default; `resolveConfig()` at `sidecar/src/index.ts:126`). Loading `'user'` = `~/.claude` pulls in the user's existing Claude Code env: **native tool defaults, the user's own permission rules, skills, commands.**
- `mcpServers: this.registry.mcpServers()` — registers the in-process `nightcore` MCP server with the full custom tool set (`tool-registry.ts:34-36`, `index.ts:42-53`).
- `agents: nightcoreAgents` — built-in subagents (`agent-presets.ts`).

So the model sees **two overlapping surfaces** for the same capabilities: native `Read`/`Write`/`Bash`/`Grep`/`Glob` from the SDK *and* `mcp__nightcore__read_file`/`write_file`/`run_command`/`grep`/`glob`/`list_dir`/`git_status`/`git_diff`. The custom MCP tools carry risk metadata (so they prompt cleanly); the native ones don't (so they get denied under dontAsk / always prompt). The model, told the native ones fail, retreats to MCP tools and subagents — the confusion the user reported.

**AutoMaker reference (UX target).** AutoMaker's autonomous mode is the model the user runs Claude Code in:
- `apps/ui/server-bundle/dist/lib/sdk-options.js:179-180`: `permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true`.
- `claude-provider.js:180-181`: `// AUTONOMOUS MODE: Always bypass permissions for fully autonomous operation` → `permissionMode: 'bypassPermissions'`.
- AutoMaker also uses **tool presets** (`readOnly`, `chat`, `fullAccess`, `specGeneration`) via `allowedTools` (`sdk-options.js:255-412`) — i.e. it never carries a parallel custom-MCP duplicate of native tools; it gates the *native* surface with allow-lists per phase.

### Gaps

- No mode value reaches the SDK beyond `acceptEdits/plan/default`. `bypassPermissions`/`dontAsk` are blackholed at `settings.rs:200-203`.
- `allowDangerouslySkipPermissions` never set → bypass impossible even if the mode arrived.
- Native tools have no risk descriptor → unknown→dangerous→denied under unattended modes; no sane read-only allow-list exists.
- Dual tool surface (native + MCP duplicate) confuses the agent and doubles the permission noise.
- No per-task permission override (mode is global/per-project only; `TaskPatch` has no permission field — `task.rs:173-182`).

### Fix

**F1.1 — Add a `bypass` mode end-to-end. (P0)**
- `Rust core` (`settings.rs`): extend the UI vocabulary and mapping. Add `"bypass"` (and optionally `"dont-ask"`) to the `permission_mode` set and map `"bypass" => "bypassPermissions"`, `"dont-ask" => "dontAsk"` in `sdk_permission_mode` (`:195-203`). Drop/relax the fail-closed test at `:309` (it currently *enforces* the gap). **Size: S.**
- `Rust core` (`provider.rs:281-288`): the start-session JSON already forwards `permissionMode`; no change needed there once the mapping emits the new string.
- `engine` (`session-runner.ts:118-145`): when `permissionMode === 'bypassPermissions'`, also set `allowDangerouslySkipPermissions: true` on `Options` (mirror `automaker sdk-options.js:179-180`). **Size: S.**
- `contracts`: already supports the modes (`config.ts:11-19`) — no change.
- `web`: add `Bypass` to the permission-mode control in `SettingsView` (alongside auto-accept/plan/ask). **Size: S.**

**F1.2 — Ship a sane read-only allow-list so non-bypass dogfooding is usable. (P0)**
- `contracts`/`Rust core` config defaults: seed `PermissionPolicy.allow` with the read-only native tools (`Read`, `Grep`, `Glob`, `LS`/`list_dir`, `Bash` git-status/diff *or* the read-only MCP equivalents) so they auto-allow instead of prompting. Today `allow: []` (`config.ts`). **Size: S–M** (decide native vs MCP — see F1.4).
- `engine` (`permission-layer.ts:87-92`): consider giving native read-only tools a known `safe` risk via the registry (F1.4) so the `risk === undefined → dangerous` fallback stops denying them. **Size: S.**

**F1.3 — Per-task permission override. (P1)**
- `Rust core` (`task.rs`): add `permission_mode: Option<String>` to `Task` and `TaskPatch` (`:173-182`); thread it into `start_session` (see F5 for the symmetric effort change). **Size: M.**
- `contracts`/`web`: surface a per-task permission picker (reuse the picker from F5). **Size: M.**

**F1.4 — Resolve the dual tool surface. (P1, design decision)**
Two viable directions — recommend **(a)** to match AutoMaker and the user's Claude-Code mental model:
- **(a) Drop the custom MCP tools; gate the native surface.** Remove `mcpServers: this.registry.mcpServers()` from `session-runner.ts:122` (keep the registry only for risk metadata) and instead classify *native* tools with risk + allow-lists (AutoMaker's `TOOL_PRESETS` model). Pros: one surface the model already understands from Claude Code; native git/Bash "just work"; less code to maintain. Cons: lose Nightcore's typed in-process tool implementations; risk metadata must be re-keyed to native tool names.
- **(b) Keep MCP tools; suppress native tools** via `disallowedTools` for the build kind. Pros: keeps Nightcore's controlled tool impls. Cons: fights the user's expectation that git/Bash work; more maintenance; subagents still reach for native tools.
- **Owning tiers:** `engine` + `contracts` + `Rust core` (allow-list defaults). **Size: L** (this is the structural one — scope as its own sub-task).

---

## Q2 — Tool-call visibility: show real args/files, not just names (P1)

### Current state

**The arg data is already on the wire.** `translateAssistant` emits `tool-use-requested` with `input: block.input ?? {}` (`sdk-adapter.ts:281-286`). The event schema carries it: `ToolUseRequestedEvent` has `input: z.record(z.string(), z.unknown())` (`events.ts:96-103`). `tool-result` carries `content` (`events.ts:106-112`), and `permission-required` carries `input` + `risk` (`events.ts:115-127`).

**The web layer drops it.** The fold function stores only the name: `session-stream.ts` `ToolLine = {id, toolName}` and the `tool-use-requested` case appends `{id: toolSeq++, toolName}` (no `input`). `tool-result` and `permission-required` have no case (ignored). The renderer prints only the name:
```tsx
// TaskDetail.tsx:163-170
<li … className="… text-primary/80">
  <TerminalIcon size={12} />
  {tool.toolName}
</li>
```
Ironically the **permission prompt already does this right**: `PermissionPrompt.hooks.ts:5-16` `summarizeInput()` prefers `command | file_path | path | url | pattern` then truncated JSON, rendered in a `<pre>` (`PermissionPrompt.tsx:17-23`). That helper is the exact primitive the transcript needs.

**AutoMaker** renders the tool target (file/command) inline in its activity stream — confirming the UX expectation that a tool line shows *what* it touched, not just its name.

### Gap

Pure web-tier rendering gap. Data is present end-to-end; `session-stream.ts` truncates it and `TaskDetail` doesn't render it.

### Fix

**F2.1 — Carry and render tool input. (P1)**
- `web` (`session-stream.ts`): widen `ToolLine` to `{id, toolName, input?, summary?, result?, isError?}`; in the `tool-use-requested` case keep `input` (or precompute a one-line summary); add a `tool-result` case that attaches `content`/`isError` to the matching `toolUseId`. **Size: S–M.**
- `web` (`TaskDetail.tsx:155-172`): render the summarized arg next to the name. **Reuse `summarizeInput`** from `PermissionPrompt.hooks.ts` — promote it to a shared util (e.g. `lib/` or `components/ui`) so the transcript and the prompt share one formatter. **Size: S.**
- No contracts/engine/Rust change required.

---

## Q3 — Transcript persistence (P1)

### Current state

- **In-memory only.** `useBoard` holds `const [streams, setStreams] = useState<Record<string, SessionStream>>({})` (`AppShell.hooks.ts:264`); the `nc:session` listener folds each event into it (`:303-313`). It is **cleared on project activate/delete** (`:277`) and **reset to `{}` on any page reload** (plain `useState`, no persistence).
- **Rust core streams live, never logs.** `sidecar.rs` emits each event to the webview via `app.emit("nc:session", {taskId, event})` (event const `SESSION_EVENT = "nc:session"`); it does not write events to disk.
- **`SessionStore` is metadata-only by design.** `packages/storage/src/index.ts:10` (verbatim): *"We deliberately do NOT store transcripts — the SDK owns those as resumable JSONL on disk. This store keeps only the bookkeeping the harness needs (tags, status, cost, the mapping from our monotonic id to the SDK session UUID)."* It appends one `SessionRecord` per line to `<home>/sessions/index.jsonl` (`:23,:31-39`).
- **The SDK keeps its own transcript** (resumable JSONL, conventionally under `~/.claude/projects`), but Nightcore never references or surfaces it.

### Gap

The user-visible task transcript (assistant text + tool calls + results) is ephemeral: lost on reload and unrecoverable after the session retires. The SDK's copy exists but isn't wired to the UI, and the Nightcore→SDK session-UUID mapping (stored in `SessionRecord`) isn't used to locate it.

### Fix

**F3.1 — Persist a per-task transcript JSONL. (P1)** Recommended: Rust core owns it (it's the always-on event hub).
- `Rust core` (`sidecar.rs`): in the same place it emits `nc:session`, also append the event to a per-task file, e.g. `~/.nightcore/transcripts/<taskId>.jsonl` (or under per-project `.nightcore/`). Add a `read_transcript(taskId)` Tauri command. **Size: M.**
- `web` (`bridge.ts` + `AppShell.hooks.ts`): on task select / reload, `invoke('read_transcript', {taskId})` to reseed the `streams[taskId]` entry instead of starting empty; fold persisted events through the existing `foldSession`. **Size: M.**
- Alternative (lower-effort, less control): surface the SDK's own transcript by resolving it from `SessionRecord.sdkSessionId` + the project path and reading the SDK JSONL. Pros: no new write path. Cons: format coupling to the SDK's on-disk schema, and it only covers SDK-native turns, not Nightcore's normalized events. Prefer the Nightcore-owned JSONL for stability. **Size: M.**

---

## Q4 — Markdown rendering as a reusable shared component (P2)

### Current state

- **No markdown dependency.** `apps/web/package.json` deps are `@tauri-apps/api`, `@tauri-apps/plugin-dialog`, `lucide-react`, `react`, `react-dom` — no `react-markdown`/`marked`/`remark`/`markdown-it`.
- Assistant output: raw text in `<pre className="whitespace-pre-wrap …">{answer}</pre>` (`TaskDetail.tsx:174-194`).
- Review verdict: raw text in `<pre …>{task.review}</pre>` (`ReviewPanel.tsx:35-37`).
- Shared primitives live in `apps/web/src/components/ui/` (`Badge`, `Button`, `Card`, `EmptyState`, `IconButton`, `IconTile`, `Kbd`, `StatusDot`, `BrandMark`, `icons`, `index.ts`) — the right home for a new primitive.

### Gap

No markdown formatting anywhere; the two surfaces that most need it (live transcript, review verdict) render raw, and any plan text would too.

### Fix

**F4.1 — Add a shared `<Markdown>` primitive. (P2)**
- `web` (deps): add `react-markdown` (+ `remark-gfm` for tables/checklists; optionally `rehype-sanitize` since content is model-generated). **Size: S.**
- `web` (`components/ui/Markdown.tsx` + export from `components/ui/index.ts`): a thin wrapper with project typography classes, mirroring the existing primitive style. **Size: S.**
- Consumers: swap the raw `<pre>` in `TaskDetail.tsx:174-194` (assistant transcript), `ReviewPanel.tsx:35-37` (verdict), and any plan-text surface to `<Markdown>`. Keep `<pre>` for the error branch (raw stderr). **Size: S.**
- Keep it a pure presentational primitive (no data fetching) so all three surfaces consume one component.

---

## Q5 — Per-task model + reasoning effort (P2)

### Current state

- **`Task.model` exists; `Task.effort` does not.** `task.rs:78` `pub model: Option<String>` (doc: "None ⇒ use the core/config default model"). No effort field anywhere in the struct (`:70-128`). `TaskPatch` has `model` but no effort (`:173-182`).
- **`StartSessionCommand` carries both.** `commands.ts:24` `model`, `:28` `effort: EffortLevelSchema.optional()`, `:30` `permissionMode`, `:36` `kind`.
- **Engine threads effort correctly.** `session-manager.ts:168` `const effort = command.effort ?? this.config.effort;` → `:197` passed to `SessionRunner` → `session-runner.ts` builds `Options` with `...(this.cfg.effort !== undefined ? { effort } : {})`.
- **Rust drops effort on the floor.** The provider signature has no effort param and the JSON payload omits it:
  ```rust
  // provider.rs:272-288
  async fn start_session(&self, task_id, prompt, model: Option<String>, cwd, permission_mode: Option<String>, kind: &str) -> …
  let command = json!({ "type":"start-session","prompt":prompt,"model":model,
                        "cwd":…,"permissionMode":permission_mode,"kind":kind });
  ```
  The launch site passes model+permission_mode+kind but no effort (`coordinator.rs:388-399`; same in the manual run path `sidecar.rs:716-726`). So **effort is only ever a global/session default** from `~/.nightcore/config.json`; per-task effort cannot be expressed.
- **No model/effort picker in the UI.** `NewTaskForm` collects title/description/kind only; `TaskCard`/`TaskDetail` *display* `task.model` (dot + name) but offer no editor. Model/effort are set globally + per-project in `SettingsView` (`MODELS`, `EFFORTS` segmented controls). **No `listModels()` call exists in web** — the model list is hardcoded.
- **Model discovery exists but is unused by web.** `session-manager.ts:138-165` `listModels()` → `SessionRunner.supportedModels()` (transient probe), returning `ModelDescriptor` incl. `supportedEffortLevels` (per-model effort gating, `sdk.d.ts:1169`). This is the path the old TUI used; the web app never invokes it (no Tauri `list_models` command wired).

### Gap

To pick model AND effort per task from the UI: (1) `Task`/`TaskPatch` need an `effort` field; (2) Rust `start_session` must thread effort into the payload; (3) a UI picker must set both; (4) ideally the picker is populated from `listModels()` with per-model effort gating instead of hardcoded lists.

### Fix

**F5.1 — Thread effort through the Rust core. (P2)**
- `Rust core` (`task.rs`): add `effort: Option<String>` to `Task` (`:70-128`) and `TaskPatch` (`:173-182`); default `None`. **Size: S.**
- `Rust core` (`provider.rs:272-288`): add an `effort: Option<String>` param and add `"effort": effort` to the start-session JSON. Update both call sites (`coordinator.rs:388-399`, `sidecar.rs:716-726`) to pass `task.effort.clone()`. **Size: M.**
- No engine/contract change — `StartSessionCommand.effort` (`commands.ts:28`) and `session-manager.ts:168` already consume it.

**F5.2 — Per-task model + effort picker. (P2)**
- `web` (`NewTaskForm` + `TaskDetail`): add model + effort pickers; send via `create_task`/`update_task` (extend the Rust create/patch commands to accept model+effort — `model` is already on `TaskPatch`). **Size: M.**
- `web` (`bridge.ts`): extend the `Task` type with `effort` and the create/patch calls. **Size: S.**

**F5.3 — Dynamic model list + per-model effort gating. (P3, nice-to-have)**
- `Rust core`: add a `list_models` Tauri command that drives the engine's `listModels()` via the sidecar. `engine`/`sidecar`: expose a `list-models` command/response over NDJSON (the engine method exists; only the surface wiring is missing). **Size: M–L.**
- `web`: populate the model picker from it and disable effort levels not in `supportedEffortLevels`. **Size: M.**

---

## Prioritized fix list

> P0 blocks usable dogfooding. Sizes: S ≈ <½ day, M ≈ ~1 day, L ≈ multi-day.

| # | Fix | Tier(s) | Size | Pri |
|---|-----|---------|------|-----|
| **F1.1** | Add `bypass` (+ `dont-ask`) permission mode end-to-end; map in `settings.rs`, set `allowDangerouslySkipPermissions:true` in `session-runner.ts`, add UI option. Remove the fail-closed test that pins the gap (`settings.rs:309`). | Rust core · engine · web | S | **P0** |
| **F1.2** | Seed a sane read-only allow-list (native read tools / read-only MCP) in config defaults so non-bypass dogfooding stops prompting on every read; give native read tools a known `safe` risk so they aren't denied under dontAsk. | contracts · Rust core · engine | S–M | **P0** |
| **F2.1** | Carry tool `input` into `session-stream.ts` (+ `tool-result`), render arg summary in `TaskDetail`; promote `summarizeInput` to a shared util. | web | S–M | **P1** |
| **F3.1** | Persist per-task transcript JSONL in Rust core alongside the live `nc:session` emit; add `read_transcript` command; reseed `streams` on select/reload. | Rust core · web | M | **P1** |
| **F1.4** | Resolve the dual native+MCP tool surface (recommend: drop custom MCP tools, gate native tools with risk+allow-lists à la AutoMaker `TOOL_PRESETS`). | engine · contracts · Rust core | L | **P1** |
| **F1.3** | Per-task permission override (`Task`/`TaskPatch` + picker). | Rust core · contracts · web | M | **P1** |
| **F4.1** | Shared `<Markdown>` primitive (`react-markdown`+`remark-gfm`+sanitize) in `components/ui`; consume in transcript, review verdict, plan text. | web | S | **P2** |
| **F5.1** | Thread `effort` through Rust `start_session` (add to `Task`/`TaskPatch`, provider signature, JSON payload, both call sites). | Rust core | M | **P2** |
| **F5.2** | Per-task model + effort picker in create/edit UI. | web · Rust core | M | **P2** |
| **F5.3** | Dynamic model list via engine `listModels()` + per-model effort gating (replace hardcoded lists). | Rust core · engine · sidecar · web | M–L | **P3** |

### Suggested sequencing for the dogfood unblock
1. **F1.1 + F1.2 together** — restores the "git + shell just work" experience the user wants (bypass mode globally; sane read-only allow-list for the cautious path). This is the single highest-leverage change.
2. **F2.1** — makes the stream legible (see *what* each tool touched) with no backend change.
3. **F3.1** — survives reloads; pairs naturally with F2.1's richer `ToolLine`.
4. **F1.4** — the structural cleanup that makes 1–3 coherent; schedule as its own task.
5. **F4.1**, then **F5.x** — quality-of-life polish.

---

## Key evidence index (file:line)

- Permission resolution order: `packages/engine/src/permission-layer.ts:74-99` (unknown risk → dangerous at `:90`).
- Native tools have no descriptor → `riskOf` undefined: `packages/engine/src/tool-registry.ts:50-64`; custom tool risks `packages/tools/src/index.ts:57-128` (`run_command` dangerous `:128`).
- Rust mode mapping fail-closed: `apps/desktop/src-tauri/src/settings.rs:195-203`; pinned by test `:309`.
- SDK mode union + bypass requirement: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1995`, `:1647-1660`.
- `allowDangerouslySkipPermissions` never set: absent from `packages/engine/src/session-runner.ts:118-145, 200-237`.
- Dual surface: `session-runner.ts:122` (mcpServers), `:218` (settingSources `'user'`→`~/.claude`).
- AutoMaker bypass reference: `…/automaker/apps/ui/server-bundle/dist/lib/sdk-options.js:179-180`; `…/providers/claude-provider.js:180-181`; tool presets `sdk-options.js:255-412`.
- Tool input on the wire: `packages/engine/src/sdk-adapter.ts:281-286`; `packages/contracts/src/events.ts:96-103`.
- Web drops input / name-only render: `apps/web/src/components/board/session-stream.ts` (`ToolLine{id,toolName}`); `apps/web/src/components/board/TaskDetail/TaskDetail.tsx:155-172`.
- `summarizeInput` to reuse: `apps/web/src/components/board/PermissionPrompt/PermissionPrompt.hooks.ts:5-16`.
- Transcript ephemeral: `apps/web/src/components/app/AppShell/AppShell.hooks.ts:264, 277, 303-313`.
- Storage metadata-only: `packages/storage/src/index.ts:10, 23, 31-39`.
- No markdown / raw `<pre>`: `apps/web/package.json` (deps); `TaskDetail.tsx:174-194`; `ReviewPanel.tsx:35-37`. UI primitives: `apps/web/src/components/ui/`.
- Effort threaded in engine but dropped in Rust: `packages/contracts/src/commands.ts:28`; `packages/engine/src/session-manager.ts:168, 197`; `apps/desktop/src-tauri/src/m2/provider.rs:272-288`; `coordinator.rs:388-399`; `sidecar.rs:716-726`. Task fields: `task.rs:78` (model), no effort; `task.rs:173-182` (TaskPatch).
- Model discovery unused by web: `packages/engine/src/session-manager.ts:138-165`; `ModelDescriptor.supportedEffortLevels` `sdk.d.ts:1169`.
