# Combined Findings: Nightcore Project State + Claude Agent SDK Opportunity

**Date:** 2026-06-24
**Skill:** /kirei-chain
**Lenses:** arch, general, refactor
**Scope:** What is built/working vs. scaffolded/parked/not-wired-up across the 3-tier architecture (Rust core ↔ Bun sidecar ↔ React board); end-to-end integration gaps; and whether the Claude Agent SDK offers capabilities Nightcore should adopt.

## Per-Lens Reports
- **Architecture (as-built integration map + Mermaid):** docs/arch/2026-06-24-asbuilt-integration-map.md
- **Feature inventory + Agent SDK eval:** docs/research/2026-06-24-feature-inventory-and-agent-sdk-opportunity.md
- **Scaffolding / dead-code / structural debt:** docs/refactor/2026-06-24-scaffolding-dead-code-debt.md

## Headline (premise inversion — verified)
Nightcore is **already built on the Claude Agent SDK** — `@anthropic-ai/claude-agent-sdk@^0.3.185` (packages/engine/package.json:21), imported and driving `query()` in streaming-input mode (sdk-adapter.ts:17-18, session-runner.ts:230). It is NOT parsing raw `claude` CLI stdout; the SDK spawns the CLI as its own transport. So "migrate from CLI-shell-out to the SDK" is a non-question. The real question is **how much more SDK surface to adopt**.

The 3-tier architecture is **real and fully wired end-to-end**, and healthier than the prior 2026-06-22 wiring map: all three previously-flagged structural risks are closed (both contract boundaries codegen'd; compiled sidecar bundled via externalBin; CLI fail-fast guard live). IPC surface is perfectly symmetric — 35 Tauri commands = 35 registered = 35 invoked from bridge.ts, zero orphans; 5 nc:* event channels each 1 emitter + 1 listener; zero circular deps (madge). And the tree is genuinely clean: `cargo check` 0 warnings, `eslint` 0 unused, zero `todo!()`/`unimplemented!()`, exactly one TODO in all of TS. **There is no true dead code.**

## Cross-Cutting Themes (appeared in 2+ lenses — highest leverage)
1. **The custom-tool MCP seam is dormant — flagged by ALL THREE lenses.** The agent runs on native SDK tools (Read/Write/Edit/Bash/Grep/Glob) since M4.7 §A2. `session-runner.ts:171-221` builds SDK `Options` with **no `mcpServers` key** (verified). `ToolRegistry.buildSdkMcpServer/mcpServers/descriptors` (tool-registry.ts:45,54,59) assemble the parked `@nightcore/tools`+`@nightcore/mcp` packages but have **zero live callers** — refactor calls this "live-dead." The only surviving live edge into `@nightcore/tools` is `riskOf()` (session-runner.ts:148 → permission-layer.ts:74), a risk-classification lookup, not executable tools. arch: "decide revive or remove." general: "adopt `Options.mcpServers` to light up the parked seam when needed." refactor: "parked-intentional, do NOT delete." → This is the single highest-leverage decision in the repo.
2. **One untyped boundary remains — the inbound sidecar NDJSON event read.** Both contract boundaries are codegen'd (zod→Rust generated.rs; Rust serde→web TS via ts-rs), EXCEPT the inbound event reader, which still reads `event.get("camelCase")` and forwards the raw `Value` (reader.rs). Flagged by arch ("lowest-risk seam left") and general ("sidecar NDJSON boundary still hand-mirrored, no codegen"). Adding any SDK field means hand-updating provider.rs/sidecar.rs with no compile guard.
3. **Docs and comments lag the code.** arch: top-level docs/architecture.md + docs/diagrams.md still describe the retired v0 CLI/TUI layering and "10 in-process MCP tools." refactor: 3 stale code comments claim "not yet wired" for things that ARE wired (m2/deps.rs:6 "coordinator not yet scaffolded" — it is; store/settings.rs:34 + generated Settings.ts:11 "M2 loop not enforcing max_concurrency/maxTurns" — it is, via SlotManager + Options.maxTurns). Cheap to fix; actively misleading until then.

## Conflicts Between Lenses
- **Revive vs. remove the tools/mcp seam.** arch lists "remove (execute the later removal pass)" as a valid option; refactor insists the packages are parked-intentional and must NOT be deleted; general recommends KEEP and adopt `mcpServers`. **Resolution:** treat as a conscious product decision, not a cleanup. The weight of evidence (general's SDK eval + the MEMORY parked-seam note) favors **revive-or-consciously-defer, never blind-delete**. Pick a direction so the seam stops reading as ambiguous.
- No hard technical conflicts otherwise — the three lenses corroborate rather than contradict.

## Unified Priority Order
1. **Decide the custom-tool MCP seam: revive or consciously park** (cross-cut, all 3 lenses) — owner: arch + general. If revive: wire `ToolRegistry.mcpServers()` into SDK `Options.mcpServers` + integration test. If park: leave as-is but document the decision in-code so it stops reading as drift. — Effort M, Risk Med.
2. **Confirm the "already-on-SDK" framing with the user, then adopt P1 SDK surface** — owner: general. (a) SDK session functions (listSessions/getSessionMessages/getSessionInfo/renameSession/tagSession) to back a per-task history/resume UX (resume is already plumbed, no UX yet); (b) structured `outputFormat: json_schema` for the M4 reviewer verdict, replacing the fragile prose parse. — Effort S→M.
3. **Fix the 3 stale comments + regen Settings.ts, and refresh the stale top-level docs** (cross-cut: arch + refactor) — Effort S, Risk Low. Fix at the Rust serde source, regen via `cargo test`.
4. **Bump SDK 0.3.185 → 0.3.187** (no breaking changes; V2 SDK was removed in 0.3.142, do not chase it) — Effort XS.
5. **Structural debt** (refactor): split AppShell.hooks.ts (1101 LOC, 14 hooks hidden behind one exported useAppShell to skirt max-hooks-per-file) into colocated component .hooks.ts; extract a shared NumberField to dedupe LimitField≈NumberField. — Effort S→L.
6. **Optionally type the inbound NDJSON event read** (`try_into::<NightcoreEvent>()` with raw fallback) — Effort S, Risk Low.

## Recommended Execution Strategy
Stagger, don't bundle. **Gate on #1** — the tools/mcp decision is a prerequisite that changes whether items touch the MCP transport path. Then:
- **PR A (cheap truth-in-docs):** items #3 + #4 — stale comments, Settings.ts regen, doc refresh, SDK bump. Low risk, high signal-to-noise, lands immediately.
- **PR B (SDK adoption):** item #2 — session-history/resume UX is SIMPLE→kirei-build; the `outputFormat` reviewer-verdict change is COMPLEX→kirei-forge because it crosses the engine + the hand-mirrored Rust NDJSON seam (item #6 is a natural companion here).
- **PR C (tools/mcp):** item #1 once decided — COMPLEX→kirei-forge.
- **PR D (frontend debt):** item #5 — independent of the rest; #5's AppShell split is governed by custom lint rules (max-hooks-per-file ≤4 exported, no-cross-feature-imports) so order matters.
Run the gates after each step: `cargo test` (regenerates ts-rs + runs the contract conformance suite), `bun run codegen:contracts --check`, `bun run --filter @nightcore/web typecheck`, `eslint .`, web/node tests.

## Out of Scope (surfaced but not investigated)
- **STUB-IN-PROGRESS:** `task kind = research` is selectable in the picker (status.ts:161) but its engine preset returns `{}` (kind-presets.ts:73) and Rust gives it no worktree/verify (kind.rs:43) — selectable before its behavior exists. Inversely, `task kind = review` is disabled in the picker (status.ts:162) yet the review machinery IS live as the verification-gate reviewer. Worth a feature-completeness follow-up.
- **Retained v0 surfaces:** apps/cli + apps/tui drive the engine in-process, bypassing the sidecar/Rust 3-tier path entirely (tag v0-ts-harness). Keep-or-retire is a product call.
- **session-manager.ts:47 "SPIKE: runners in-process":** a deferred crash-isolation architecture decision — confirm intent before treating as WIP.
- **Resume/worktree coupling gotcha:** SDK `resume` is cwd-keyed (~/.claude/projects/<encoded-cwd>/); pruning a task's worktree orphans its session history — must be coordinated with any resume UX.
- Codex second provider (trait seam ready, parked); auto-update (research only).
