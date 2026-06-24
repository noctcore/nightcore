# Research: UI-configurable external MCP servers

**Date:** 2026-06-24
**Agent:** kirei
**Status:** complete
**Overall complexity:** COMPLEX → hand off to kirei-forge

## Problem

Let users add/edit/remove/enable external MCP servers through the Nightcore UI
(NOT hardcoded in packages) so those servers become available to Claude sessions.
This follows the agreed 2026-06-24 direction: Nightcore relies on Claude's native
tools + permission model and ships NO in-house tool/MCP packages (the old
`@nightcore/tools` + `@nightcore/mcp` were removed). MCP must be user-configurable.

The wiring point is `Options.mcpServers` in
`packages/engine/src/session-runner.ts` (today there is NO `mcpServers` key).

## Grounding: the data-flow reality (the crux)

Confirmed by reading the code, NOT assumed:

1. **Two separate config systems.** The Bun sidecar builds its engine `Config`
   by calling `resolveConfig()` (`packages/config/src/index.ts:84`), which reads
   `~/.nightcore/config.json` + `<cwd>/.nightcore/config.json` — it does **NOT**
   read the Rust `settings.json` store. The Rust `SettingsStore`
   (`apps/desktop/src-tauri/src/store/settings.rs`) is a *separate* store whose
   values reach the engine only as **per-session fields on the `start-session`
   command** (`apps/desktop/src-tauri/src/sidecar/commands.rs:73` →
   `provider.start_session(...)`), never via the engine's own `Config`.
   → MCP config persisted in the Rust store must travel on `start-session`
     (per-session injection), because the engine never reads the Rust store.

2. **The injection seam is additive, not replacing.** `Options.mcpServers`
   (`sdk.d.ts:1620`, `Record<string, McpServerConfig>`) is **merged** with the
   user's on-disk `.mcp.json` / `~/.claude.json` **unless** `strictMcpConfig:
   true` is set (`sdk.d.ts:1865-1871`). The session-runner does NOT set
   `strictMcpConfig`, so injected servers are ADDITIVE to whatever Claude config
   the user already has. This is exactly the behavior we want (Nightcore-managed
   servers layer on top of the user's native ones; no clobbering).

3. **Inspector cohesion is real and fixable.** The provider-config inspector
   reads `mcpServerStatus()` off a transient probe built by `withProbe()` →
   `baseOptions()` (`session-runner.ts:384` / `:428`). `baseOptions()` passes
   **no** `mcpServers`. So if we inject servers ONLY into the main run's options
   (naive Option B), the inspector would NOT show them. The fix is one line of
   cohesion: also fold the injected servers into `baseOptions()` so the probe
   resolves the same merged set the run does.

4. **Risk model already covers this.** `packages/engine/src/tool-registry.ts:17`
   classifies any unknown `mcp__*` tool as `dangerous` → always prompt-worthy
   (never silently auto-allowed). External MCP servers run arbitrary commands;
   this gating already holds and needs no change. (In `bypass` mode the studio's
   default still skips prompts — that is the user's explicit autonomous choice,
   unchanged by this feature.)

## Reference: exact SDK shapes (pinned to in-repo `sdk.d.ts`, 0.3.185)

`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

```ts
// Options.mcpServers — the injection seam (line 1620)
mcpServers?: Record<string, McpServerConfig>;   // keyed by SERVER NAME

// McpStdioServerConfig (line 1092)
{ type?: 'stdio'; command: string; args?: string[]; env?: Record<string,string>;
  timeout?: number; alwaysLoad?: boolean }
//   note: `type` is OPTIONAL for stdio (defaults to stdio); `command` REQUIRED.

// McpHttpServerConfig (line 962)
{ type: 'http'; url: string; headers?: Record<string,string>;
  tools?: McpServerToolPolicy[]; timeout?: number; alwaysLoad?: boolean }
//   `type` REQUIRED = 'http'; `url` REQUIRED.

// McpSSEServerConfig (line 1076)
{ type: 'sse'; url: string; headers?: Record<string,string>;
  tools?: McpServerToolPolicy[]; timeout?: number; alwaysLoad?: boolean }
//   `type` REQUIRED = 'sse'; `url` REQUIRED. (SSE is deprecated upstream; HTTP preferred.)

// McpSdkServerConfig / WithInstance (line 978/987) — in-process server, NOT
// serializable, NOT user-configurable. Out of scope; never persist or inject this.
```

`strictMcpConfig?: boolean` (line 1871) — leave UNSET so injected servers merge
with the user's native config rather than replacing it.

## Reference: Claude's native config (Ref/docs)

From `https://code.claude.com/docs/en/mcp` (canonical reference):

- **Project scope** → `.mcp.json` at the project root (checked into VCS):
  `{ "mcpServers": { "<name>": { "command": "...", "args": [], "env": {} } } }`.
- **User scope** → `~/.claude.json` (cross-project, private).
- **Local scope** (default for `claude mcp add`) → `~/.claude.json` under the
  current project's path (`projects["/abs/path"].mcpServers`).
- **Scope precedence** (highest first; the entire entry from the winning source
  is used — fields are NOT merged across scopes):
  1. Local 2. Project 3. User 4. Plugin-provided 5. claude.ai connectors.
- The transport `type` field: `http` (alias `streamable-http`), `sse`, `stdio`,
  `ws`. `claude mcp add` / `claude mcp add-json` is the canonical writer.
- Project-scoped `.mcp.json` servers prompt for trust before first use.

## The design fork — Option A vs B, with the recommendation

### Option A — manage Claude's native config
Nightcore's UI reads/writes the standard Claude MCP config (project `.mcp.json`
and/or user `~/.claude.json`).
- Pro: native; SDK/CLI pick them up automatically; inspector shows them with zero
  extra wiring; they work outside Nightcore; maximally "lean on Claude native."
- Con: editing **user-owned** files (`~/.claude.json` holds far more than MCP —
  it is the user's whole Claude Code state; a bad merge can corrupt it);
  scope/precedence handling; JSON-merge safety; surprising side effects outside
  the app. `~/.claude.json` is undocumented-as-a-stable-schema and large.

### Option B — Nightcore store + inject
Persist in Nightcore's own store; inject into `Options.mcpServers` at session build.
- Pro: full control; isolated; never touches user files; trivially scoped to
  enabled entries; serde-additive store evolution we already do everywhere.
- Con (the only real one): the inspector's SDK probe wouldn't reflect injected
  servers — but that is a one-line cohesion fix (fold the same servers into
  `baseOptions()`), which eliminates the con.

### RECOMMENDATION — principled HYBRID (Option B + inspector cohesion)

**Persist in the Nightcore Rust store; inject into BOTH the run's
`Options.mcpServers` AND the inspector probe's `baseOptions()`.** Do NOT write
the user's `.mcp.json` / `~/.claude.json`.

Why, specifically:
- The engine never reads the Rust store, so "the SDK picks it up automatically"
  (Option A's headline pro) is **not actually free** here — it would still need
  the engine to read a file Nightcore writes, i.e. we'd be hand-merging
  `~/.claude.json`, the riskiest possible target. Injection is strictly safer.
- Injection merges additively with the user's native config (no `strictMcpConfig`),
  so the user's existing `.mcp.json`/`~/.claude.json` servers still work — we get
  Option A's "native servers keep working" property without editing those files.
- The inspector con is removed by passing the same servers into `baseOptions()`;
  configured servers then appear in the existing inspector with their live SDK
  status, satisfying the noted cohesion.
- Single source of truth (the Rust store), serde-additive evolution, matches every
  existing Nightcore config pattern (settings.rs).

This is genuinely "lean on Claude native" where it counts: Claude's permission
model, Claude's resolution/merge, Claude's live status — Nightcore only owns the
*list*, and never mutates the user's files.

## Decisions to confirm (flagged — do not assume)

1. **Scope (project vs user-global) for P1.**
   - **Kirei recommendation: GLOBAL-ONLY for P1**, mirroring the existing Settings
     "global block" (no per-project override yet). One user-global list applied to
     every session is the simplest correct first cut and matches the user-scope
     mental model. Per-project overrides can be added later with the exact same
     `projectOverrides` pattern `settings.rs` already uses (additive, low-risk).
   - Alternative if the orchestrator wants completeness now: GLOBAL + PER-PROJECT,
     reusing `SettingsOverride`/`SettingsPatch.projectId` plumbing.

2. **Enable/disable toggle in P1.**
   - **Kirei recommendation: YES, include `enabled` in P1.** It is one boolean on
     the entry and one filter at injection time; it avoids the delete-to-disable
     churn and makes the UI feel complete. Only `enabled` entries inject.

The build plan below assumes **global-only + `enabled` in P1**. If the orchestrator
chooses global+per-project, step 3 gains a `projectOverrides`-style map (the
`settings.rs` pattern is the template) and step 5 resolves project→global like
`SettingsStore::default_model`.

## Exact types (zod + Rust + TS)

### Where the type LIVES (important codegen note)

The MCP entry needs to be **both** persisted in the Rust store (ts-rs → web TS,
like `Settings`) **and** carried on the `start-session` command (zod spine →
`generated.rs`, the NDJSON contract). To avoid drift, define it **once in the zod
spine** (`packages/contracts/src/config.ts`) so:
- the engine consumes the typed shape directly from `@nightcore/contracts`;
- `start-session`'s new `mcpServers` field references it, so the codegen emits the
  Rust mirror in `generated.rs` automatically;
- the Rust **store** struct (`settings.rs`) is a hand-written serde struct that
  serializes to the SAME camelCase wire shape and is ts-rs-exported for the web
  Settings form. (The store struct and the contract struct describe the same JSON;
  the conformance/round-trip tests keep them aligned, exactly as `Settings` works
  today.)

### zod (NEW, in `packages/contracts/src/config.ts`)

Codegen constraints honored (verified against `tools/codegen/gen-rust-contracts.ts`):
- use `z.record(z.string(), z.string())` for `env`/`headers` (NOT `z.unknown()`),
  which the emitter maps to `serde_json::Map<String, serde_json::Value>`;
- transport is a **discriminated union tagged by `transport`** (NOT `type`, to
  avoid colliding with the SDK's optional stdio `type`; we translate `transport`
  → SDK `type` in the engine). The emitter supports nested discriminated unions
  (see `PermissionDecision`); add a `UNION_NAMES` entry for it.

```ts
/** Transport-tagged config for one external MCP server the user wires via the UI.
 *  Mirrors the SDK's McpServerConfig variants but tagged by `transport` so the
 *  contract codegen emits a clean Rust enum. Translated to the SDK `type` field
 *  in the engine. */
export const McpServerTransportSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
  z.object({
    transport: z.literal('sse'),
    url: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);
export type McpServerTransport = z.infer<typeof McpServerTransportSchema>;

/** One user-configured external MCP server entry. `id` is a stable UI key (uuid);
 *  `name` is the SDK server key (the `mcp__<name>__*` tool prefix). `enabled`
 *  gates injection. */
export const McpServerEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean().default(true),
  config: McpServerTransportSchema,
});
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;
```

Then extend `StartSessionCommand` (`packages/contracts/src/commands.ts`):

```ts
  /** External MCP servers (enabled entries only) the Rust core injects for this
   *  session. Folded into the SDK `Options.mcpServers` by name. Absent ⇒ none. */
  mcpServers: z.array(McpServerEntrySchema).optional(),
```

This makes the codegen emit `Vec<McpServerEntry>` + the `McpServerEntry` /
transport enum into `generated.rs` automatically — add the fixture for
`start-session` (`gen-rust-contracts.ts` `COMMAND_INPUTS['start-session']`) and a
`UNION_NAMES['transport:stdio|http|sse'] = 'McpServerTransport'` +
`STRUCT_NAMES` entry for the entry's field signature so the Rust names are stable.

### Rust store struct (NEW, hand-written in `settings.rs`, ts-rs-exported)

Serializes to the same camelCase wire shape; lives in the global Settings block.

```rust
/// One user-configured external MCP server. Serde-additive; ts-rs exports it for
/// the Settings MCP form. Mirrors the `McpServerEntry` contract shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "McpServerEntry.ts"))]
pub struct McpServerEntry {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub config: McpServerTransport,
}

/// Transport-tagged MCP server config (serde internally-tagged by `transport`).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[cfg_attr(test, derive(TS))]
#[serde(tag = "transport", rename_all = "camelCase")]
#[cfg_attr(test, ts(export, export_to = "McpServerTransport.ts"))]
pub enum McpServerTransport {
    #[serde(rename_all = "camelCase")]
    Stdio { command: String, #[serde(default)] args: Vec<String>,
            #[serde(default)] env: std::collections::HashMap<String, String> },
    #[serde(rename_all = "camelCase")]
    Http { url: String,
           #[serde(default)] headers: std::collections::HashMap<String, String> },
    #[serde(rename_all = "camelCase")]
    Sse { url: String,
          #[serde(default)] headers: std::collections::HashMap<String, String> },
}
```

Add to `Settings` (global block) + `SettingsPatch`:
```rust
// in Settings:
#[serde(default)]
pub mcp_servers: Vec<McpServerEntry>,        // serde-additive: legacy files → []
// in SettingsPatch (whole-list replace is simplest + race-free):
#[cfg_attr(test, ts(optional))]
pub mcp_servers: Option<Vec<McpServerEntry>>,
```
List CRUD via whole-list replace on the patch (the UI sends the full next list).
A `SettingsStore::enabled_mcp_servers()` resolver returns only `enabled` entries.

### TS (generated, do NOT hand-edit)

`apps/web/src/lib/generated/McpServerEntry.ts`,
`McpServerTransport.ts` (ts-rs from the store structs) and the contract mirror in
`generated.rs` (codegen). The web imports `McpServerEntry` via the bridge re-export.

## Ordered build plan (one logical step per commit)

> Convention: commit to **main**, small conventional commits, **no AI/co-author
> attribution**. Run the FULL gate sequence after each step (see Verification).

**Step 1 — contract types (SIMPLE)**
`packages/contracts/src/config.ts`: add `McpServerTransportSchema` +
`McpServerEntrySchema` (above). Add unit coverage in `config.test.ts`
(parse/default each transport; reject a bad transport tag). Wire `index.ts`
already re-exports `config.js`, so types are exported automatically.
*Commit:* `feat(contracts): add the user-configurable MCP server entry types`

**Step 2 — thread the type onto `start-session` + codegen (SIMPLE→COMPLEX)**
`packages/contracts/src/commands.ts`: add the optional `mcpServers` field to
`StartSessionCommand`. `tools/codegen/gen-rust-contracts.ts`: add the
`start-session` fixture `mcpServers` payload, a `UNION_NAMES` entry
(`'transport:stdio|http|sse' → 'McpServerTransport'`) and a `STRUCT_NAMES` entry
for `McpServerEntry`'s field signature. Run `bun run codegen:contracts` and commit
the regenerated `generated.rs` + `fixtures.json`. The Rust conformance test in
`contracts/mod.rs` proves round-trip.
*Commit:* `feat(contracts): carry external MCP servers on the start-session command`

**Step 3 — Rust store: persist + CRUD (COMPLEX)**
`apps/desktop/src-tauri/src/store/settings.rs`: add `McpServerEntry` +
`McpServerTransport` structs (ts-rs-exported), `mcp_servers: Vec<…>` on `Settings`
(serde `default` = `[]`, serde-additive), `mcp_servers: Option<Vec<…>>` on
`SettingsPatch` (whole-list replace in `merge`), and a
`SettingsStore::enabled_mcp_servers()` resolver. Reuse `update_settings` (no new
command needed — the patch path already persists + returns merged settings).
Tests: legacy-file-without-field → `[]`; round-trip a list; `enabled_mcp_servers`
filters; camelCase serialization includes `mcpServers`.
*Commit:* `feat(store): persist user-configured external MCP servers in settings`

**Step 4 — Rust → start-session wiring (COMPLEX)**
`apps/desktop/src-tauri/src/m2/provider.rs` (the `start_session` signature /
`Guardrails`-style payload) + `apps/desktop/src-tauri/src/sidecar/commands.rs`
(`run_task`) + the coordinator auto-loop launch: read
`SettingsStore::enabled_mcp_servers()` and pass them as the new `mcpServers`
field on the `start-session` command. (Global-only P1 ⇒ no project arg needed; if
global+per-project is chosen, resolve project→global here like
`default_model`.) The contract type is already in `generated.rs` from Step 2.
*Commit:* `feat(engine): pass enabled MCP servers on session start`

**Step 5 — engine: build `Options.mcpServers` (run + probe) (COMPLEX)**
`packages/engine/src/session-manager.ts` `startSession()`: forward
`command.mcpServers` into the new `SessionRunnerConfig.mcpServers`.
`packages/engine/src/session-runner.ts`:
- add `mcpServers?: McpServerEntry[]` to `SessionRunnerConfig`;
- a pure helper `toSdkMcpServers(entries)` → `Record<string, McpServerConfig>`
  (filter `enabled`; map `transport` → SDK `type`; stdio omits `type`, http/sse
  set it; copy `command/args/env` or `url/headers`);
- in `run()`'s `options`, add `...(servers ? { mcpServers: servers } : {})`;
- **cohesion:** in `baseOptions()` add the SAME `mcpServers` so the inspector
  probe resolves the merged set and configured servers show up in the inspector.
  (Decide whether the model-probe runner — `makeProbeRunner` — also carries them;
  recommend yes for consistency, but it never runs a turn so it's cosmetic.)
Tests (`session-runner.test.ts`): `toSdkMcpServers` maps each transport correctly,
drops disabled entries, omits stdio `type`, sets http/sse `type`; an empty/absent
list leaves `mcpServers` UNSET (byte-identical to today).
*Commit:* `feat(engine): inject configured MCP servers into the SDK options`

**Step 6 — Settings UI (COMPLEX)**
New folder-per-component under `apps/web/src/components/settings/` (e.g.
`McpServersCard/`) with `.tsx`, `.types.ts`, `.hooks.ts`, `.test.tsx`,
`.stories.tsx` per convention. Surface it on the existing **`providers`** page in
`SettingsView.tsx` `buildCards()` (the INTEGRATIONS group already has "Providers"
— natural home; keeps step independent of the inspector). Features:
- list enabled/disabled MCP entries with transport + name;
- add/edit via a **transport-aware form** (stdio: command/args/env; http+sse:
  url/headers) with validation (non-empty name unique across entries; command
  required for stdio; valid URL for http/sse);
- remove; per-row `enabled` `Toggle` (reuse the existing `Toggle`);
- persist by sending the **whole next list** via `updateSettings({ mcpServers })`
  (extend `bridge.ts` `updateSettings` + `MOCK_SETTINGS.mcpServers = []`).
Reuse `SettingsCard`, `Segmented`, `Toggle`, `NumberField` idioms; match the
`useSettingsView` patch flow. Global scope only in P1 (the MCP card ignores the
scope tab, or disables it, until per-project lands).
*Commit:* `feat(web): add the MCP servers settings UI`

## Files to modify

- `packages/contracts/src/config.ts` — add `McpServerTransportSchema` +
  `McpServerEntrySchema` (Step 1).
- `packages/contracts/src/config.test.ts` — parse/default/reject tests (Step 1).
- `packages/contracts/src/commands.ts` — add `mcpServers` to `StartSessionCommand`
  (Step 2).
- `tools/codegen/gen-rust-contracts.ts` — fixture + `UNION_NAMES` + `STRUCT_NAMES`
  (Step 2).
- `apps/desktop/src-tauri/src/contracts/generated.rs` + `fixtures.json` —
  REGENERATED by codegen, committed (Step 2). Never hand-edit.
- `apps/desktop/src-tauri/src/store/settings.rs` — store structs, `Settings` +
  `SettingsPatch` fields, `enabled_mcp_servers()` resolver, tests (Step 3).
- `apps/web/src/lib/generated/McpServerEntry.ts` + `McpServerTransport.ts` —
  emitted by `cargo test` (ts-rs), committed (Step 3). Never hand-edit.
- `apps/desktop/src-tauri/src/m2/provider.rs` — `start_session` payload carries the
  list (Step 4).
- `apps/desktop/src-tauri/src/sidecar/commands.rs` — `run_task` reads
  `enabled_mcp_servers()` and passes it (Step 4). Mirror in the auto-loop launch.
- `packages/engine/src/session-manager.ts` — forward `command.mcpServers` (Step 5).
- `packages/engine/src/session-runner.ts` — `SessionRunnerConfig.mcpServers`,
  `toSdkMcpServers`, run options + `baseOptions()` cohesion (Step 5).
- `packages/engine/src/session-runner.test.ts` — `toSdkMcpServers` coverage (Step 5).
- `apps/web/src/components/settings/McpServersCard/*` — new component (Step 6).
- `apps/web/src/components/settings/SettingsView/SettingsView.tsx` — surface the
  card on the `providers` page (Step 6).
- `apps/web/src/lib/bridge.ts` — `updateSettings` already takes a patch; add
  `mcpServers: []` to `MOCK_SETTINGS`; re-export `McpServerEntry` type (Step 6).

## Reference files (do not modify)

- `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — the SDK type pins
  (lines 962/978/1076/1092/1620/1865).
- `apps/desktop/src-tauri/src/sidecar/provider_config.rs` — the inspector that
  benefits from the `baseOptions()` cohesion (no edit needed; it already reads
  `mcpServerStatus()`).
- `packages/engine/src/tool-registry.ts` — risk map; `mcp__*` already `dangerous`
  (no change).

## Risks & gotchas

- **Codegen throws on unsupported zod.** Use `z.record(z.string(), z.string())`
  (NOT `z.unknown()`) for `env`/`headers`. Register the nested union in
  `UNION_NAMES` and the struct in `STRUCT_NAMES` or the Rust names will be
  path-derived and unstable. Run `bun run codegen:contracts` and commit the diff.
- **ts-rs export location.** Run `cargo test` **from inside**
  `apps/desktop/src-tauri/` so the new `McpServerEntry.ts` / `McpServerTransport.ts`
  land in `apps/web/src/lib/generated/`, not a stray `bindings/`.
- **stdio `type` is OPTIONAL in the SDK** (`type?: 'stdio'`). `toSdkMcpServers`
  should OMIT `type` for stdio and SET it for http/sse, matching the SDK union.
- **`transport` tag, not `type`.** We tag the contract/store union by `transport`
  to keep the Rust enum clean and avoid the SDK's optional-`type` ambiguity; the
  engine translates `transport` → SDK `type`. Don't reuse `type` as the wire tag.
- **Do not set `strictMcpConfig`.** Leaving it unset keeps injected servers
  ADDITIVE with the user's native `.mcp.json`/`~/.claude.json` (desired). Setting
  it would silently disable the user's own native servers.
- **Name = SDK key.** The entry `name` becomes the `mcpServers` record key and the
  `mcp__<name>__*` tool prefix. Enforce uniqueness + a safe charset in the UI
  validation (the SDK keys on it; duplicates collide).
- **Two structs, one JSON.** The contract `McpServerEntry` (zod→generated.rs) and
  the store `McpServerEntry` (hand-written serde) must serialize identically. This
  is the SAME pattern `Settings` uses today; the round-trip/conformance tests are
  the guard. If the orchestrator prefers ONE struct, the store could deserialize
  into the contract-mirror type — but the existing repo pattern is two aligned
  structs, so follow it unless directed otherwise.
- **Secrets in `env`/`headers`.** Tokens may live here. Keep them out of
  info/telemetry logs (the runner already logs config at debug only; preserve
  that). Persisted in plaintext in `settings.json` — same trust model as the
  user's own `~/.claude.json`; note it, don't over-engineer for P1.
- **bypass mode.** In the studio's default `bypass` permission mode, MCP tools are
  NOT prompted (autonomous choice). That's existing behavior; this feature does
  not change it. Mention in the UI hint that MCP tools run under the session's
  permission mode.

## How to verify

Gate sequence (run after each step; ALL must pass):
1. `cd apps/desktop/src-tauri && cargo test`  (run INSIDE the crate so ts-rs
   exports land in `apps/web/src/lib/generated/`).
2. `bun run codegen:contracts --check`  (drift guard for `generated.rs`/fixtures).
3. `bun run --filter @nightcore/web typecheck`  (root `tsc -b` does NOT typecheck
   apps/web).
4. `eslint .`
5. `bun run test:node` + `bun run test:web`.

Functional verification:
- Add a stdio MCP server (e.g. `npx -y @modelcontextprotocol/server-filesystem .`)
  via the Settings UI; confirm it persists across an app restart
  (`settings.json` carries `mcpServers`).
- Start a task; confirm the agent can call the server's `mcp__<name>__*` tools and
  that the permission layer treats them as `dangerous` (prompts in `ask` mode).
- Open the provider-config inspector (board header) and confirm the configured
  server appears with a live status (proves the `baseOptions()` cohesion).
- Toggle the server `enabled: false`; confirm it no longer injects (absent from a
  new session's tools and from the inspector).

## Open questions (for the orchestrator)

1. **Scope:** global-only (kirei rec) vs global+per-project for P1?
2. **Enable toggle:** include `enabled` in P1 (kirei rec: yes)?
3. **One struct vs two:** follow the existing two-aligned-structs pattern (rec) or
   collapse the store onto the contract mirror type?
4. **Secret handling for P1:** plaintext in `settings.json` (same as
   `~/.claude.json`) acceptable for P1, or is masking/keychain a P1 requirement?
