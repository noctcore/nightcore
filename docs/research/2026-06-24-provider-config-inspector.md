# Research: Provider Configuration Inspector (read-only, provider-abstracted)

**Date:** 2026-06-24
**Agent:** kirei
**Status:** complete

## Problem
Design a NEW read-only "provider configuration inspector" for Nightcore: a button/panel that shows the user how the active AI provider (today: Claude) is configured for the CURRENT project — its MCP servers and its skills (plus a tight set of high-value extras). The defining requirement is that it be ABSTRACTABLE behind a provider-capability seam mirroring Nightcore's existing provider modeling, with a first-class per-section "unsupported / can't show for this provider" state so a future provider (e.g. Codex) slots in additively and degrades gracefully. Cross-tier (Bun engine ↔ Rust core ↔ React board); hands to kirei-forge.

## Root Cause / Core Findings (grounded in code + SDK types)

### F1 — The most robust data source is the SDK's runtime control methods, not hand-parsed JSON.
The pinned `@anthropic-ai/claude-agent-sdk` exposes, on the live `Query` object, control methods returning the SDK's RESOLVED config (scope precedence applied):
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:2281` — `mcpServerStatus(): Promise<McpServerStatus[]>` → `{ name, status:'connected'|'failed'|'needs-auth'|'pending'|'disabled', scope?:'project'|'user'|'local'|'claudeai'|'managed', serverInfo?, tools?, config? }` (`sdk.d.ts:1001-1042`). Best MCP source — merged set WITH scope + connection status.
- `sdk.d.ts:2263` — `supportedCommands(): Promise<SlashCommand[]>`; skills surface as `SlashCommand` `{ name, description, argumentHint, aliases? }` (`sdk.d.ts:6076`). `reloadSkills()` (`:2329`) → `{ skills: SlashCommand[] }` (`:3359`).
- `sdk.d.ts:2275` — `supportedAgents(): Promise<AgentInfo[]>` → subagents `{ name, description, model? }` (`:97`).
- `sdk.d.ts:2257` — `initializationResult(): Promise<SDKControlInitializeResponse>` → `{ commands, agents, output_style, available_output_styles, models, account }` (`:3186`).
- The `init` system message already carries the cheap summary (`sdk.d.ts:3977`): `model, permissionMode, tools[], slash_commands[], skills[], mcp_servers[{name,status}], output_style, agents?, plugins[], cwd, apiKeySource`.

### F2 — A proven transient-probe pattern exists to reuse verbatim.
`packages/engine/src/session-manager.ts:274` `listModels()` → `makeProbeRunner()` (`:293`) builds a `SessionRunner` and calls `runner.supportedModels()`. `SessionRunner.supportedModels()` (`packages/engine/src/session-runner.ts:305`) spins a TRANSIENT `query({ prompt: emptyInputStream(...), options: baseOptions() })`, asks the control method, tears down in `finally` via abort controller. NO model turn, no cost. Inspector reads follow this exact shape with `cwd` = PROJECT ROOT (resolution keys off cwd; `baseOptions()` at `:341` threads `cwd, settingSources, skills:'all', pathToClaudeCodeExecutable`).

### F3 — The read-only NDJSON request/reply path already exists and fits.
- zod `SurfaceQuery` union — `packages/contracts/src/commands.ts:120-173` (each carries `requestId`).
- `QueryResultEvent` reply: `kind` discriminator + optional payload slots + `ok`/`error` — `packages/contracts/src/events.ts:224-239`.
- Engine `SessionManager.handleQuery()` switch — `session-manager.ts:170-258`; backed by degrade-not-throw `SessionApi` (`session-api.ts`).
- Sidecar dispatch (command-then-query fallback) — `apps/sidecar/src/index.ts:130-144`.
- Rust send/await: `Provider::query()` injects `requestId`, registers oneshot, writes, 20s timeout — `apps/desktop/src-tauri/src/m2/provider.rs:120,608-662`; reader intercepts `query-result` by `requestId` → `correlate_reply` — `sidecar/reader.rs:29-44`.
- Tauri wrapper mapping reply→view + active-project root — `sidecar/sessions.rs:130-159`; registered `lib.rs:102-106`.
The inspector adds ONE query variant + reply kind + ONE Tauri command; no new transport.

### F4 — The provider seam to MIRROR.
- `apps/desktop/src-tauri/src/m2/provider.rs:62-125` — `#[async_trait] pub trait Provider` ("additive sidecar + factory arm, never a `match provider` branch").
- Web placeholder: `apps/web/src/components/settings/SettingsView/SettingsView.tsx:569-601` — Providers tab, Claude card + "Other providers / Codex — Coming soon" (`badge:'later'`).

### F5 — Contract is codegen'd both ways; new types go at the source only.
- zod → Rust `generated.rs` via `tools/codegen/gen-rust-contracts.ts` (`bun run codegen:contracts`; `--check` guards). Emitter handles unions/`z.enum`/`z.optional`/`z.default`/`z.nullable`/`z.array`/`z.record`, THROWS on anything else. Register named types in `STRUCT_NAMES`/`ENUM_NAMES`/`UNION_NAMES` (`:241-268`) + add fixtures in `QUERY_INPUTS`/`EVENT_INPUTS` (`:653-810`) or the coverage guard fails.
- Rust serde view → web TS via ts-rs (`#[cfg_attr(test, derive(ts_rs::TS))]` + `ts(export,...)`), exported to `apps/web/src/lib/generated/` by `cargo test` run inside `apps/desktop/src-tauri`. Pattern: `sidecar/sessions.rs:40-76` (`SessionInfoView`).

## Provider-Capability Abstraction (core deliverable)

### Tri-state per section (NOT error, NOT empty-list)
- `supported` + `data` — provider reports it.
- `unsupported` — provider DECLARES it can't report this (UI: "Not available for this provider").
- `unavailable` + `error` — supported in principle, read failed now (UI: soft error + retry).

### Zod (new `packages/contracts/src/provider-config.ts`, re-export from index.ts)
```ts
import { z } from 'zod';
export const ConfigSectionStatusSchema = z.enum(['supported','unsupported','unavailable']);
export const McpServerSummarySchema = z.object({
  name: z.string(), status: z.string(), scope: z.string().optional(),
  transport: z.string().optional(), toolCount: z.number().int().nonnegative().optional(),
});
export const SkillSummarySchema = z.object({ name: z.string(), description: z.string().optional() });
export const SubagentSummarySchema = z.object({ name: z.string(), description: z.string().optional(), model: z.string().optional() });
export const ProviderConfigSectionSchema = z.object({
  status: ConfigSectionStatusSchema,
  error: z.string().optional(),
  mcpServers: z.array(McpServerSummarySchema).optional(),
  skills: z.array(SkillSummarySchema).optional(),
  subagents: z.array(SubagentSummarySchema).optional(),
});
export const ProviderConfigSnapshotSchema = z.object({
  providerId: z.string(), providerLabel: z.string(), projectPath: z.string(),
  mcp: ProviderConfigSectionSchema, skills: ProviderConfigSectionSchema, subagents: ProviderConfigSectionSchema,
  model: z.string().optional(), permissionMode: z.string().optional(), outputStyle: z.string().optional(),
  extrasStatus: ConfigSectionStatusSchema,
});
export type ProviderConfigSnapshot = z.infer<typeof ProviderConfigSnapshotSchema>;
```

### New SurfaceQuery variant (commands.ts → SurfaceQuerySchema union)
```ts
export const GetProviderConfigQuery = z.object({
  ...requestTarget, type: z.literal('get-provider-config'), dir: z.string().optional(),
});
```

### Extend QueryResultEvent (events.ts)
```ts
kind: z.enum(['sessions','session-info','messages','ack','provider-config']),
providerConfig: ProviderConfigSnapshotSchema.optional(),
```

### Generated Rust (emitted by codegen — register names, never hand-edit generated.rs)
Codegen emits `SurfaceQuery::GetProviderConfig { request_id, dir }` and `provider_config: Option<ProviderConfigSnapshot>` in the QueryResult arm, plus serde mirrors. Register: `ENUM_NAMES['supported|unsupported|unavailable']='ConfigSectionStatus'`; `STRUCT_NAMES` for the field-key sigs of the 5 new structs; `QUERY_INPUTS['get-provider-config']` + extend `EVENT_INPUTS['query-result']` (kind + providerConfig).

### Rust Provider trait method (mirror the seam)
Add ONE method to `m2/provider.rs` `trait Provider`, default-implemented over `query()`:
```rust
async fn provider_config(&self, dir: Option<String>) -> Result<Value, String> {
    let q = SurfaceQuery::GetProviderConfig { request_id: String::new(), dir };
    self.query(q).await
}
```
`SidecarProvider` inherits it unchanged. A future `CodexProvider` overrides it (or its engine emits `unsupported` sections). Per-section tri-state = each provider declares its own capabilities WITHOUT a `match provider` branch in the core.

### How a 2nd provider slots in later (concrete)
1. New sidecar speaks the same NDJSON protocol; its engine handles `get-provider-config` returning a snapshot with `providerId:'codex'`, `status:'unsupported'` for sections it can't report.
2. Rust: a new `impl Provider` (factory arm by config) — no inspector code changes.
3. Web: panel already renders per-section `unsupported` → "Not available for this provider"; ZERO new UI branches.

## Recommended P1 scope (tight)
MCP servers (name/status/scope/transport/toolCount), Skills (name/description), Subagents (name/description/model — near-free on the same probe), scalar extras (model/permissionMode/outputStyle from init). Defer (label "later" via `badge`): hooks, allow/deny tool lists, context-usage breakdown, plugins.

## Data-source decision (recommended — flag for orchestrator)
Primary: SDK transient-probe (F1+F2), resolved + scope-aware, matches `listModels()`. Documented fallback (optional for P1, degrade-not-throw): hand-read `.mcp.json` (project) + project-keyed/user `mcpServers` in `~/.claude.json` (precedence local>project>user>plugin per Claude Code docs); skills via `<project>/.claude/skills/*/SKILL.md` + `~/.claude/skills/*/SKILL.md`. Probe is authoritative; fallback is a nicety.

## Files to Modify / Create (ordered, one commit each)

### Step 1 — Contract types (SIMPLE)
- CREATE `packages/contracts/src/provider-config.ts`; EDIT `index.ts` (re-export); EDIT `commands.ts` (add `GetProviderConfigQuery` to union); EDIT `events.ts` (extend `QueryResultEvent.kind` + `providerConfig` slot); EDIT `commands.test.ts`/`events.test.ts`.

### Step 2 — Codegen registration + regenerate (COMPLEX)
- EDIT `tools/codegen/gen-rust-contracts.ts` (`ENUM_NAMES`, `STRUCT_NAMES`, `QUERY_INPUTS`, `EVENT_INPUTS`); RUN `bun run codegen:contracts` (emits `generated.rs`+`fixtures.json` — never hand-edit).

### Step 3 — Engine reader (COMPLEX)
- CREATE `packages/engine/src/provider-config.ts` (`ProviderConfigReader`, degrade-not-throw per section like `SessionApi`).
- EDIT `packages/engine/src/session-runner.ts` (add `mcpServerStatus`/`supportedAgents`/`supportedCommands`/`initializationResult` proxies on the `supportedModels()` template `:305-330`; accept a `cwd` override).
- EDIT `packages/engine/src/session-manager.ts` (`get-provider-config` arm in `handleQuery` `:174`; probe runner `cwd = query.dir ?? process.cwd()`).
- EDIT `packages/engine/src/index.ts` (export). Tests alongside.

### Step 4 — Rust command + view + trait (COMPLEX)
- EDIT `m2/provider.rs` (`provider_config()` default trait method).
- CREATE `apps/desktop/src-tauri/src/sidecar/provider_config.rs` (recommended) — `#[tauri::command] get_provider_config(app, orch, dir?) -> ProviderConfigSnapshotView` mapping `kind=='provider-config'` to a ts-rs view (mirror `SessionInfoView`), default `dir` from `active_project_root` (`sessions.rs:112`).
- EDIT `sidecar/mod.rs` (`pub(crate) use`); EDIT `lib.rs` (register in `generate_handler!` `:92-133`).
- RUN `cargo test` inside `apps/desktop/src-tauri` (exports TS bindings).

### Step 5 — Web bridge + panel + entry (COMPLEX)
- EDIT `apps/web/src/lib/bridge.ts` (`getProviderConfig(projectPath?)`, mirror `listTaskSessions` `:230`, safe browser default).
- CREATE `apps/web/src/components/.../ProviderConfigPanel/` (folder-per-component): renders each section; `unsupported`→"Not available for this provider", `unavailable`→soft error+retry, `supported`→grouped list. Reuse `<SettingsCard>` card/row + the collapsible pattern from `SessionHistory`/`TaskDetail.tsx:355-384`.
- WIRE entry: RECOMMENDED board header (per-project) + a read-only summary under Settings→Providers next to the Claude card (`SettingsView.tsx:569-601`). (Flag for confirmation.)

## Reference Files (do not modify)
- `apps/desktop/src-tauri/src/sidecar/sessions.rs` — query→command→view to clone.
- `packages/engine/src/session-manager.ts:170-310` — handleQuery + `listModels`/`makeProbeRunner`.
- `packages/engine/src/session-runner.ts:305-376` — `supportedModels()` transient query + `baseOptions()`.
- `apps/web/src/components/board/SessionHistory/`, `apps/web/src/components/settings/SettingsCard/` — UI idioms.
- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1001,2257-2329,3186,3977` — SDK control-method + init shapes.

## Risks & Gotchas
- The probe spawns the SDK's bundled Claude CLI per read — bound it (existing 20s `QUERY_TIMEOUT` covers `Provider::query`) and tear down via abort controller exactly like `supportedModels()`, else a subprocess leaks.
- `skills:'all'` + `Skill` tool only when `settingSources` non-empty (`session-runner.ts:370-373`); strict isolation (`settingSources:[]`) legitimately yields empty skills — that is `supported` with `[]`, NOT `unsupported`.
- Codegen THROWS on unhandled zod constructs; stay in the supported subset; `z.unknown()` is rejected (use `z.record(z.string(), z.unknown())`).
- ts-rs bindings only regenerate when `cargo test` runs INSIDE `apps/desktop/src-tauri`.
- `mcpServerStatus()` reflects connect state at probe time (mid-reconnect = `pending`); surface verbatim, don't normalize away.
- Per-section independence is the point: one failing section → that section `unavailable`, never a failed snapshot. Wrap each probe call in its own try/catch.

## How to Verify
1. `cd apps/desktop/src-tauri && cargo test` (TS bindings + contract conformance).
2. `bun run codegen:contracts --check` (no drift).
3. `bun run --filter @nightcore/web typecheck`.
4. `eslint .`.
5. `bun run test:node && bun run test:web`.
6. Manual: project with `.mcp.json`+`.claude/skills/` → panel lists them w/ scope+status; bare project → `supported` empty lists, not errors; stub an `unsupported` section → "Not available for this provider".

## Open Questions (for orchestrator / kirei-forge)
- Confirm three flagged decisions: (a) SDK-probe primary vs hybrid; (b) trait-method+contract vs contract-only; (c) UI board header vs Settings vs both. Recommendations: hybrid-leaning-probe, trait+contract, board-header + Settings summary.
- Rust command home: new `sidecar/provider_config.rs` (recommended) vs extend `sessions.rs`.
- Subagents in P1 (recommended yes) vs deferred.
