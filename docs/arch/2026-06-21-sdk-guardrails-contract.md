# SDK Guardrails Contract — maxTurns + maxBudgetUsd + session resume

**Date:** 2026-06-21 · **Status:** FROZEN (orchestrator-owned). Serde-additive.
**Grounding:** `docs/research/2026-06-21-sdk-usage-audit.md` (read it fully first — every SDK capability below is cited there with a `sdk.d.ts` line; confirm each in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` before wiring).
**Runs in:** worktree B, in parallel with the Settings-sweep contract (worktree A).

## Ownership / boundaries (avoid collisions with worktree A)
- **You OWN:** `packages/engine/**` (esp. `session-runner.ts`, `session-manager.ts`, `sdk-adapter.ts`), the start-session **command** portion of `packages/contracts/src/**`, the Task fields + launch payload assembly in `apps/desktop/src-tauri/src/` (`provider.rs`, `coordinator.rs`, `sidecar.rs`) **only for the guardrail/resume fields**, and any new Tauri command you add for rewind (if you do the stretch).
- **DO NOT TOUCH (worktree A owns):** `apps/web/src/components/settings/**`, `settings.rs`, the desktop notification path, About data, the model/effort/run-mode default-resolution. Default values for YOUR fields live in `@nightcore/config`, NOT in the Tauri settings struct.
- If you must add a Task field that `task.rs` defines alongside fields A also edits, keep your additions in their own contiguous block and serde-additive so the merge is mechanical.
- Keep all suites green: `bun run test:rust`, `test:web`, `test:node`, `test:plugin` (or `test:all`).

## A. FIRM — maxTurns + maxBudgetUsd (autonomy ceilings)
The studio runs bypass-mode with NO turn or cost ceiling. Add both:
1. **SDK Options.** In `session-runner.ts`, set `maxTurns` and `maxBudgetUsd` on the SDK `Options` (`sdk.d.ts:1587`, `:1591`) when present.
2. **Source.** Per-task optional override → `@nightcore/config` default. Sensible defaults: `maxTurns` a finite guard (e.g. 200), `maxBudgetUsd` optional (default `undefined` = uncapped) — pick defensible numbers and centralize them in config. Do NOT add a Tauri settings struct field (worktree A owns settings.rs); a Settings UI knob is a deferred follow-up.
3. **Contract + Task.** Add `maxTurns?`/`maxBudgetUsd?` to the start-session command schema and `max_turns`/`max_budget_usd` (serde-additive, `Option`) to the Rust `Task` + `TaskPatch` + create; thread them into the launch payload (`provider.rs:272-288` region).
4. **Stop-reason handling.** The result already maps `'max-turns'` — ensure a budget/turn stop produces a clear terminal event/outcome (a parked/needs-attention state, not a silent success). Emit a NightcoreEvent the web can show; don't treat it as a verified pass.
5. Tests: node tests for the Options builder picking up per-task vs config default; cargo test for the serde-additive Task fields + launch payload.

## B. FIRM — Session resume via persisted sdkSessionId
We persist `sdkSessionId` (`session-manager.ts:249`) but never reattach.
1. When launching a task that already has a persisted `sdkSessionId`, pass `resume` (and `resumeSessionAt` if appropriate) on the SDK `Options` (`sdk.d.ts:1713`) so a crashed/HMR-killed session continues instead of restarting cold.
2. Wire this into the recovery path: the boot reconcile (`coordinator.rs reconcile_tasks`) or an explicit resume command should prefer resume-by-session-id when one exists. Falling back to a cold start when resume fails must be graceful (log at debug, then start fresh).
3. `forkSession` (`sdk.d.ts` near resume) is OPTIONAL this pass — only add if it falls out naturally; otherwise note as deferred.
4. Tests: the Options builder includes `resume` when a session id is present and omits it otherwise.

## C. STRETCH (only if low-risk, else defer with a note)
- **`getContextUsage()`** (`sdk.d.ts:2282`) — emit a context-usage NightcoreEvent (web display deferred).
- **`enableFileCheckpointing` + `rewindFiles()`** (`:1388`, `:2344`) — enable checkpointing + add an engine method and a Rust `rewind_task` command (UI deferred). Skip if it risks the firm scope.

## D. Guardrails
- Serde-additive; legacy tasks load with `max_turns=None`, `max_budget_usd=None`, no session id → all inherit/cold-start. Extend the pinning test.
- Confirm every SDK field name against `sdk.d.ts` before use — do not invent option names.
- No secret/token (incl. CLAUDE_CODE_OAUTH_TOKEN / sdkSessionId beyond local persistence) logged at info/telemetry; debug-only, never the token itself.
