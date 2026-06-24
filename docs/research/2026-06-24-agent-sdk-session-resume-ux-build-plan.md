# Research: Agent SDK Session/Resume UX — Cross-Tier Build Plan (P1)

**Date:** 2026-06-24
**Agent:** kirei
**Status:** complete — build-ready plan for hand-off to kirei-forge

## Problem
Turn the P1 "session/resume UX" item from docs/research/2026-06-24-feature-inventory-and-agent-sdk-opportunity.md into an ORDERED, file-by-file, cross-tier build plan: per-task SDK session HISTORY + RESUME. Resume is already plumbed engine-deep (`Options.resume`) and `task.sdk_session_id` is already persisted — but there is NO UX, and no way to LIST a task's sessions or READ a past session's messages. The make-or-break constraint: SDK sessions are cwd-keyed under `~/.claude/projects/<encoded-cwd>/`, and Nightcore uses a worktree-per-task, so pruning a worktree orphans the cwd-keyed history.

## Root Cause / Gap Analysis (verified in source)
1. **No engine API for the SDK session functions.** The engine imports `query` only (`packages/engine/src/sdk-adapter.ts:18`). It never imports `listSessions`/`getSessionMessages`/`getSessionInfo`/`renameSession`/`tagSession`. `SessionManager.dispatch` (session-manager.ts:83) only handles start/input/interrupt/model/perm/approve — all fire-and-forget.
2. **The sidecar protocol has NO request/response path.** `apps/sidecar/src/index.ts` is pure NDJSON streaming: stdin = `SurfaceCommand` lines, stdout = `NightcoreEvent` lines (index.ts:9-13). `createSidecar` wires `manager.on(event → sink)` and `handleLine(cmd → manager.dispatch)`. There is no correlated reply — a "list sessions" query that must RETURN data does not fit the existing one-way protocol.
3. **Resume is plumbed but inert UX-wise.** `task.sdk_session_id` is captured from `session-ready` (reader.rs:73-81), persisted (store/task.rs:224), and threaded back as `resumeSessionId` on relaunch via `build_guardrails` (sidecar/commands.rs:117-123) → `Guardrails.resume_session_id` → `start-session` payload (provider.rs:484) → engine `Options.resume` (session-runner.ts:214). So Nightcore ALREADY resumes the LAST session on a manual re-run. What's missing: listing a task's OTHER sessions and viewing any session's transcript before resuming a chosen one.

## SDK API — EXACT signatures (source of truth: node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts @ 0.3.185; cited doc URLs below)
All return Promises; all take a sessionId UUID + an options object whose `dir` scopes the project-dir search (omit `dir` ⇒ search ALL project dirs).

- `listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>`  (sdk.d.ts:892)
  - `ListSessionsOptions = { dir?: string; limit?: number; offset?: number; includeWorktrees?: boolean (default true); sessionStore?: SessionStore }`  (sdk.d.ts:897-924)
  - **`includeWorktrees` default true: when `dir` is inside a git repo, includes sessions from ALL git worktree paths** — this is the linchpin for the worktree problem.
- `getSessionInfo(sessionId: string, options?: { dir?: string; sessionStore?: SessionStore }): Promise<SDKSessionInfo | undefined>`  (sdk.d.ts:667, 672-684). Returns `undefined` if the file is not found / is a sidechain / has no summary.
- `getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>`  (sdk.d.ts:697)
  - `GetSessionMessagesOptions = { dir?: string; limit?: number; offset?: number; includeSystemMessages?: boolean (default false); sessionStore?: SessionStore }`  (sdk.d.ts:702-721)
- `renameSession(sessionId: string, title: string, options?: SessionMutationOptions): Promise<void>`  (sdk.d.ts:2448)
- `tagSession(sessionId: string, tag: string | null, options?: SessionMutationOptions): Promise<void>`  (sdk.d.ts:6295) — null clears the tag.
- `SessionMutationOptions = { dir?: string; sessionStore?: SessionStore }`  (sdk.d.ts:4275-…)

### Return TYPES the Rust serde structs must mirror (field names/types are LOAD-BEARING)
`SDKSessionInfo`  (sdk.d.ts:3891-3932):
```
sessionId: string          // UUID
summary: string            // custom title, auto-summary, or first prompt
lastModified: number       // ms epoch
fileSize?: number          // bytes, local JSONL only
customTitle?: string       // user-set via /rename
firstPrompt?: string
gitBranch?: string
cwd?: string
tag?: string
createdAt?: number         // ms epoch (from first entry timestamp)
```
`SessionMessage`  (sdk.d.ts:4263-4269):
```
type: 'user' | 'assistant' | 'system'
uuid: string
session_id: string
message: unknown           // raw Anthropic message JSON
parent_tool_use_id: string | null
```

## THE WORKTREE/CWD RESUME STRATEGY (the make-or-break detail — solved)
**Storage fact (cited docs):** sessions live at `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, where `<encoded-cwd>` is the absolute cwd with every non-alphanumeric char replaced by `-` (so `/Users/me/proj` → `-Users-me-proj`). Resume looks in the dir derived from the CURRENT cwd; a different cwd → looks in the wrong place → fresh session.

Nightcore's worktree-per-task gives each run a distinct cwd: `<project>/.nightcore/worktrees/<taskId>` (worktree.rs:43-45). So each run's history is keyed by that worktree path. Pruning the worktree (delete_task → cleanup_task_worktree, task.rs:535; or reconcile_worktrees, lib.rs:85; or merge cleanup) leaves the JSONL ORPHANED under the old encoded path — NOT deleted, just unreachable by a `dir`-scoped list (git can no longer enumerate the gone worktree).

**Strategy — resolve by UUID, not by dir, for the PRIMARY history path:**
1. **History list per task = sdk_session_id-anchored, not dir-scoped.** Nightcore already persists `task.sdk_session_id` (the UUID) and `task.session_id`. The per-task history view is built from `getSessionInfo(task.sdk_session_id)` **with NO `dir`** — searching ALL project dirs finds the file even after the worktree is pruned. (This is why UUID-keyed beats dir-keyed: dir-scoped `listSessions` CANNOT see a pruned worktree's sessions; a UUID lookup with no dir CAN.)
2. **Broader discovery = `listSessions({ dir: <projectRoot>, includeWorktrees: true })`** to surface sibling sessions that still have live worktrees (e.g. multiple runs of the same task, fork candidates). Project root (not the per-task worktree) is the right `dir` — `includeWorktrees:true` then fans out to every live worktree under it. Pruned-worktree sessions simply won't appear here; the UUID path (step 1) is what covers those.
3. **Orphaned-history UX.** When `getSessionInfo(uuid)` returns a record but its `cwd` no longer exists on disk (worktree pruned) → render the history entry with an **"orphaned (worktree pruned)" badge**. `getSessionMessages(uuid)` (no dir) STILL reads the transcript for read-only viewing. RESUME of an orphaned session is gated: to resume, Nightcore must re-create the worktree AT THE SAME PATH so the cwd encoding matches.
4. **Resume = re-allocate the worktree at the SAME path, then relaunch with `resume`.** `worktree::allocate` is already idempotent and reuses/recreates `<base>/<taskId>` (worktree.rs:83-87, and re-checks-out an existing `nc/<taskId>` branch). So resuming re-establishes the exact cwd whose encoding keys the session. The existing `run_task` path already threads `resume_session_id` from `task.sdk_session_id` — so once the worktree is back at the same path, the existing relaunch path resumes correctly with NO new resume plumbing. A `main`-mode task runs in the project root (stable cwd), so its history is never orphaned.
5. **Caveat to encode in the plan:** if the user picks a NON-last session from the history list to resume, set `task.sdk_session_id := <chosen uuid>` before relaunch (the resume id is read from the task). A new step (a `resume_session` command) writes the chosen uuid onto the task, re-allocates the worktree, and calls the existing run path.

## Engine transport decision (RECOMMENDED — could not validate interactively as a sub-agent)
The session functions need a query→REPLY, which the streaming protocol lacks. **Recommendation: add a correlated request/response pair to the NDJSON protocol** (a `SurfaceQuery`/`QueryResult` shape tagged with a `requestId`), staying single-process and reusing the existing sidecar child. Rationale: the persistent sidecar already holds the SDK + resolved CLI path + env; a one-shot `bun run` per query would re-pay cold-start and re-resolve the binary each call. The alternative (spawn a short-lived `bun` subprocess that prints JSON) is simpler protocol-wise but adds a process per query and a second SDK-init path — rejected for P1. **This is an assumption to confirm with the user at build time; if they prefer the one-shot subprocess, only Steps 2-4 change, not the contract field shapes.**

## ORDERED, FILE-BY-FILE BUILD PLAN (one logical step = one future commit)

### STEP 1 — Engine: thin session-API module  [SIMPLE]
- **Add** `packages/engine/src/session-api.ts`: re-export from `sdk-adapter.ts` the five SDK fns + the `SDKSessionInfo`/`SessionMessage`/option types, and expose a thin typed wrapper class/functions:
  - `listTaskSessions({ dir, limit, offset })` → `SDKSessionInfo[]`
  - `getSessionInfo(uuid, { dir? })` → `SDKSessionInfo | undefined`
  - `getSessionMessages(uuid, { dir?, limit?, offset?, includeSystemMessages? })` → `SessionMessage[]`
  - (defer `renameSession`/`tagSession` to a later commit — see Step 8)
  Each degrades-not-throws (return `[]`/`undefined` on error, log at debug) to match the engine's house style.
- **Modify** `packages/engine/src/sdk-adapter.ts`: add the five functions + `SDKSessionInfo`/`SessionMessage`/`ListSessionsOptions`/`GetSessionMessagesOptions`/`GetSessionInfoOptions`/`SessionMutationOptions` to the broad SDK import and the re-export block (keep the SDK confined to this boundary file — house rule).
- **Modify** `packages/engine/src/index.ts`: export the new session-api surface (façade rule: surfaces import only from here).
- **Tests:** `packages/engine/src/session-api.test.ts` — unit-test the wrappers against a stubbed SDK module (no live query), asserting dir/option pass-through + degrade-on-throw.
- **Gate:** `bun run test:node`, `eslint .`.

### STEP 2 — Contracts: the query/reply schemas (zod spine)  [COMPLEX]
- **Modify** `packages/contracts/src/commands.ts`: add a `SurfaceQuery` discriminated union (NEW union, parallel to `SurfaceCommand`) OR extend `SurfaceCommandSchema` with reply-bearing variants. RECOMMENDED: a NEW `SurfaceQuerySchema` union so the existing fire-and-forget `SurfaceCommand` stays untouched:
  - `ListSessionsQuery { type:'list-sessions', requestId, dir?, limit?, offset? }`
  - `GetSessionInfoQuery { type:'get-session-info', requestId, sdkSessionId, dir? }`
  - `GetSessionMessagesQuery { type:'get-session-messages', requestId, sdkSessionId, dir?, limit?, offset?, includeSystemMessages? }`
- **Modify** `packages/contracts/src/events.ts`: add a `QueryResult` event variant carrying `requestId` + a result payload, added to `NightcoreEventSchema` so the codegen + reader path stay uniform. Define result shapes mirroring the SDK return types EXACTLY:
  - `SessionInfoSchema` = { sdkSessionId, summary, lastModified, fileSize?, customTitle?, firstPrompt?, gitBranch?, cwd?, tag?, createdAt? }  (camelCase wire; note: SDK `sessionId` → Nightcore wire `sdkSessionId` for consistency with the rest of the contract, OR keep `sessionId` — pick ONE and document; recommend `sdkSessionId` to avoid colliding with the numeric Nightcore id vocabulary)
  - `SessionMessageSchema` = { type:'user'|'assistant'|'system', uuid, sessionId, message: z.record(z.string(),z.unknown()), parentToolUseId: string|null }
  - `QueryResultEvent { type:'query-result', requestId, ok:boolean, kind:'sessions'|'session-info'|'messages', sessions?:SessionInfo[], info?:SessionInfo|null, messages?:SessionMessage[], error?:string }`
- **Tests:** `packages/contracts/src/commands.test.ts` + `events.test.ts` — round-trip each new variant.
- **Gate:** `bun run test:node`. (Codegen happens in Step 3.)

### STEP 3 — Codegen: regenerate the Rust mirror + fixtures  [COMPLEX]
- **Run** `bun run codegen:contracts` to regenerate `apps/desktop/src-tauri/src/contracts/generated.rs` + `fixtures.json` from the Step-2 zod additions.
- **Modify** `tools/codegen/gen-rust-contracts.ts`: add representative inputs for each new query/result variant to `COMMAND_INPUTS`/`EVENT_INPUTS` (the coverage guard assertFullCoverage THROWS otherwise). NOTE the emitter only handles known constructs — `SessionMessage.message` MUST be `z.record(z.string(), z.unknown())` (emitter maps record → `serde_json::Map<String, serde_json::Value>`, gen-rust-contracts.ts:126-129); a bare `z.unknown()` is UNSUPPORTED and throws.
- **Verify:** the new `SurfaceQuery`/`QueryResult` enums + `SessionInfo`/`SessionMessage` structs appear in generated.rs.
- **Gate:** `bun run codegen:contracts --check` (drift guard) + `cargo test` (contract conformance suite in contracts/mod.rs loads fixtures.json).

### STEP 4 — Rust: outbound query + correlated reply plumbing  [COMPLEX]
- **Modify** `apps/desktop/src-tauri/src/m2/provider.rs`: add a `Provider::query(...)` method (or `list_sessions`/`get_session_info`/`get_session_messages`) that writes a `SurfaceQuery` NDJSON line tagged with a fresh `requestId`, and a pending-reply map (`HashMap<requestId, oneshot::Sender<QueryResult>>`) so the async caller can `await` the matching `query-result` event. Mirror the existing stdin-write discipline (write under the async mutex). Add `correlate_reply(requestId, result)` called by the reader.
- **Modify** `apps/desktop/src-tauri/src/sidecar/reader.rs`: in the event match, intercept `query-result` events, look up the pending oneshot by `requestId`, and fulfill it (do NOT forward to the board as an `nc:session` event — it's an RPC reply, not a stream event).
- **Add** `apps/desktop/src-tauri/src/sidecar/commands.rs` (or a new `sidecar/sessions.rs`): three `#[tauri::command]`s:
  - `list_task_sessions(task_id) -> Vec<SessionInfo>`: resolve the task's project root as `dir`, call provider query with `includeWorktrees:true`. Tag each entry whose `cwd` no longer exists with an `orphaned` flag (add `orphaned: bool` to the Rust `SessionInfo` wrapper, NOT the generated wire struct — compute it Rust-side).
  - `get_task_session_messages(task_id, sdk_session_id) -> Vec<SessionMessage>`: call provider with NO dir (UUID lookup, prune-safe).
  - `resume_session(task_id, sdk_session_id)`: write the chosen uuid onto `task.sdk_session_id` (store.mutate), then call the EXISTING run path (re-allocates the worktree at the same path via `resolve_worktree`/`allocate`, threads `resume_session_id` through `build_guardrails`). This is the only NEW resume entry point; it reuses run_task's body.
- **Modify** `apps/desktop/src-tauri/src/lib.rs`: register the three new commands in `tauri::generate_handler!`.
- **Tests:** unit-test the orphaned-cwd detection (a `cwd` path that doesn't exist → `orphaned:true`) and the requestId correlation (pending map fulfill/timeout) in provider.rs's test module.
- **Gate:** `cargo test`.

### STEP 5 — Sidecar/engine: handle the new queries  [SIMPLE]
- **Modify** `apps/sidecar/src/index.ts`: `createSidecar` currently validates against `SurfaceCommandSchema`. Add a parallel `SurfaceQuerySchema` parse arm: when a line is a query, call `manager.handleQuery(query)` which returns a `QueryResult`, then emit it as a `query-result` event through the same sink. Keep the degrade-not-throw discipline (a bad query logs, never kills the stream).
- **Modify** `packages/engine/src/session-manager.ts`: add `async handleQuery(q): Promise<QueryResult>` that routes to the Step-1 session-api functions and wraps the result/{ok,error}. (No runner needed — these are pure disk reads via the SDK.)
- **Modify** `apps/sidecar/src/index.ts` `SidecarManager` interface: add `handleQuery`.
- **Tests:** extend the sidecar stub-manager tests to assert a query line produces a `query-result` line with the matching `requestId`.
- **Gate:** `bun run test:node`, `eslint .`.

### STEP 6 — Web bridge: typed query wrappers  [SIMPLE]
- **Modify** `apps/web/src/lib/bridge.ts`: add `export type { SessionInfo } from './generated/SessionInfo'` + `SessionMessage` (ts-rs regenerates these from the Step-4 Rust wrappers under `apps/web/src/lib/generated/` via `cargo test`). Add three command wrappers mirroring the existing `readTranscript`/`listWorktrees` shape:
  - `listTaskSessions(taskId): Promise<SessionInfo[]>` (tauriInvoke fallback `[]`)
  - `getTaskSessionMessages(taskId, sdkSessionId): Promise<SessionMessage[]>` (fallback `[]`)
  - `resumeSession(taskId, sdkSessionId): Promise<void>`
- **Gate:** `cargo test` (regenerates the ts-rs SessionInfo/SessionMessage), then `bun run --filter @nightcore/web typecheck` (root `tsc -b` does NOT typecheck web).

### STEP 7 — Web UI: per-task session-history view + resume affordance  [COMPLEX]
- **Add** `apps/web/src/components/board/SessionHistory/` (folder-per-component, matching siblings): `SessionHistory.tsx` (the list of `SessionInfo` rows — title/summary, lastModified, gitBranch, an "orphaned" badge), `SessionHistory.hooks.ts` (fetch on mount via `listTaskSessions`, lazy-load messages via `getTaskSessionMessages` on row expand), `SessionHistory.types.ts`, `SessionHistory.stories.tsx`, `SessionHistory.test.tsx`.
- **Modify** `apps/web/src/components/board/TaskDetail/TaskDetail.tsx`: add a collapsible "History" section (mirror the existing `SessionCard` collapsible pattern, TaskDetail.tsx:244-326) below the Activity timeline, rendering `<SessionHistory>` for a task that has run (gated on `task.sdkSessionId != null`). Each row offers "View transcript" (renders `SessionMessage[]` reusing the Timeline/Markdown rendering) and "Resume" (calls `resumeSession`; for an orphaned row, the button label/tooltip explains it re-creates the worktree). Reuse `summarizeInput`/`Markdown`/`<ConfigPill>` patterns.
- **Modify** `apps/web/src/components/board/TaskDetail/TaskDetail.types.ts`: add `onResumeSession?: (taskId, sdkSessionId) => void` + the history props.
- **Modify** `apps/web/src/components/board/index.ts`: export `SessionHistory`.
- **Wire** the new handlers in the AppShell hooks that own TaskDetail's props (where `onRun`/`onCancel` are supplied).
- **Tests:** `SessionHistory.test.tsx` (renders rows, orphaned badge, resume click) + a Storybook story with mock `SessionInfo[]`.
- **Gate:** `bun run --filter @nightcore/web typecheck`, `bun run test:web`, `eslint .`.

### STEP 8 — (OPTIONAL, defer) rename/tag session  [SIMPLE]
- Extend Steps 1-7 with `renameSession`/`tagSession` (editable title/tag on a history row). Independent of resume; ship only if scope allows. RECOMMENDED to DEFER out of the P1 to keep the first landing tight (assumption — confirm at build).

## Files to Modify (consolidated)
- `packages/engine/src/sdk-adapter.ts` — import/re-export the 5 SDK session fns + their types.
- `packages/engine/src/session-api.ts` — NEW thin wrappers (degrade-not-throw).
- `packages/engine/src/session-manager.ts` — add `handleQuery`.
- `packages/engine/src/index.ts` — export the session-api surface.
- `packages/contracts/src/commands.ts` — NEW `SurfaceQuerySchema` union.
- `packages/contracts/src/events.ts` — `QueryResultEvent` + `SessionInfoSchema` + `SessionMessageSchema`.
- `tools/codegen/gen-rust-contracts.ts` — fixtures for the new variants.
- `apps/desktop/src-tauri/src/contracts/generated.rs` + `fixtures.json` — REGENERATED (do not hand-edit).
- `apps/desktop/src-tauri/src/m2/provider.rs` — outbound query + pending-reply correlation.
- `apps/desktop/src-tauri/src/sidecar/reader.rs` — intercept `query-result`, fulfill the oneshot.
- `apps/desktop/src-tauri/src/sidecar/commands.rs` (or new `sidecar/sessions.rs`) — 3 new `#[tauri::command]`s + orphaned-cwd detection.
- `apps/desktop/src-tauri/src/lib.rs` — register the 3 commands.
- `apps/sidecar/src/index.ts` — parse `SurfaceQuery`, emit `query-result`.
- `apps/web/src/lib/bridge.ts` — typed wrappers + generated type re-exports.
- `apps/web/src/lib/generated/SessionInfo.ts` + `SessionMessage.ts` — GENERATED by ts-rs (do not hand-edit).
- `apps/web/src/components/board/SessionHistory/*` — NEW folder-per-component.
- `apps/web/src/components/board/TaskDetail/TaskDetail.{tsx,types.ts}` — History section + resume props.
- `apps/web/src/components/board/index.ts` — export SessionHistory.

## Reference Files (do not modify — patterns to copy)
- `apps/desktop/src-tauri/src/store/transcript.rs` — the closest "read-data Tauri command returning Vec<T>" pattern (read_transcript).
- `apps/desktop/src-tauri/src/sidecar/commands.rs:117-123` (build_guardrails) — the EXISTING resume-id threading; resume reuses it.
- `apps/desktop/src-tauri/src/m2/worktree.rs:83-111` (allocate) — idempotent same-path worktree re-creation, the cwd-stability guarantee.
- `apps/web/src/components/board/TaskDetail/TaskDetail.tsx:244-326` (SessionCard) — the collapsible-section UI pattern to mirror for History.
- `apps/web/src/lib/bridge.ts:205-217` (readTranscript) + `:311-313` (listWorktrees) — the command-wrapper shape to copy.

## Sequencing vs. the tools/mcp REMOVAL (flagged, do NOT collide)
A separate agreed decision REMOVES `@nightcore/tools` + `@nightcore/mcp` and makes MCP UI-configurable later. This session/resume plan is INDEPENDENT: it touches `sdk-adapter.ts`/`session-manager.ts`-adjacent surfaces but NOT `tool-registry.ts`, NOT `Options.mcpServers`, NOT the parked packages. The only shared file is `session-manager.ts` (this plan ADDS `handleQuery`; the removal touches the tool-registry wiring) — additive, no conflict. Land them in either order; if both touch `session-manager.ts` in the same window, sequence the removal first OR rebase, but there is no logical dependency.

## Risks & Gotchas
- **The protocol-shape decision is load-bearing** (request/reply vs one-shot subprocess). Recommended: request/reply over NDJSON. CONFIRM with the user at build start — if they pick one-shot subprocess, Steps 2-5 change but the SDK field shapes (Step 2 result types) do NOT.
- **`z.unknown()` is unsupported by the codegen emitter** (gen-rust-contracts.ts throws on unknown constructs). Use `z.record(z.string(), z.unknown())` for `SessionMessage.message`.
- **Orphaned detection must be Rust-side** (the web can't stat the fs). Compute `orphaned = !Path::new(cwd).exists()` in the list command; the wire SessionInfo from the SDK has no such field.
- **UUID-no-dir lookup is the ONLY prune-safe read path.** A dir-scoped `listSessions` will silently miss pruned-worktree sessions — do not make it the primary per-task lister.
- **Non-last-session resume mutates `task.sdk_session_id`.** The resume id is read from the task; resuming a chosen historical session must write that uuid first, else the relaunch resumes the LAST session, not the chosen one.
- **Sidecar NDJSON boundary is hand-mirrored on the inbound read** (reader.rs `.get("camelCase")`). The new `query-result` event is forwarded/consumed in reader.rs — keep field reads in sync with the generated struct; there's no compile guard on the inbound read (known seam, item #6 in the chain doc).
- **`continue: true` is the wrong tool here** — Nightcore tracks explicit UUIDs; always use `resume` (per the feature-inventory eval P2 note). Do not introduce `continue`.

## How to Verify
1. `cargo test` — regenerates ts-rs SessionInfo/SessionMessage + passes the contract conformance suite (fixtures cover the new variants).
2. `bun run codegen:contracts --check` — no drift between zod and generated.rs.
3. `bun run --filter @nightcore/web typecheck` — the new bridge wrappers + SessionHistory typecheck (root tsc -b does NOT cover web).
4. `eslint .` + `bun run test:node` + `bun run test:web`.
5. Manual (dogfood): run a worktree-mode task to completion → open TaskDetail → History shows the session with its summary/branch. View its transcript. Prune the worktree (delete or merge-cleanup) → History row now shows the "orphaned" badge, transcript still viewable, Resume re-creates the worktree at the same path and continues with prior context.
6. Confirm `getSessionMessages(uuid)` with NO dir returns the transcript for an orphaned session (the prune-safe path).

## Open Questions (could not validate — sub-agent, AskUserQuestion unavailable)
- Protocol shape: request/reply over NDJSON (recommended) vs one-shot `bun` subprocess?
- Scope: list+view+resume only (recommended P1), or include rename/tag (Step 8) now?
- Resume strategy confirmation: UUID-keyed prune-safe + same-path worktree re-allocation + orphaned badge (recommended) vs block-resume-after-prune?
- `SessionInfo.sessionId` wire key: rename to `sdkSessionId` (recommended) or keep the SDK's `sessionId`?

## Cited SDK doc URLs
- Sessions (resume/continue/fork, listSessions/getSessionMessages, encoded-cwd storage): https://code.claude.com/docs/en/agent-sdk/sessions
- TS reference (function signatures): https://code.claude.com/docs/en/agent-sdk/typescript
- Local type source of truth: node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts @ 0.3.185 (listSessions:892, getSessionInfo:667, getSessionMessages:697, renameSession:2448, tagSession:6295, SDKSessionInfo:3891, SessionMessage:4263, ListSessionsOptions:897).
