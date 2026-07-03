# Nightcore Decision Register

The single canonical list of architectural decisions and their status. When a decision is reversed, set the old row to **superseded** and link the doc that supersedes it IN THE SAME CHANGE — never leave contradictory prose in living docs (`AGENTS.md`, `docs/architecture.md`, code comments). Each new decision also gets a dated `docs/<category>/YYYY-MM-DD-<slug>.md` with the standard header (Date / Lens / Scope / Baseline).

Status legend: ✅ active · ⛔ superseded

| ID | Date | Decision | Status | Source / Supersedes |
|----|------|----------|--------|---------------------|
| D-001 | 2026-06-23 | The user's installed `claude` binary is a required prereq; it is NOT bundled. | ✅ active | docs/arch |
| D-002 | 2026-06-24 | Remove `@nightcore/tools` + `@nightcore/mcp`; rely on Claude's native tools + permission model. MCP is UI-configurable via the SDK `Options.mcpServers`, not in-code. | ✅ active | supersedes the earlier "parked seam, don't delete" |
| D-003 | 2026-06-21 | The Claude Agent SDK runtime is confined to `packages/engine/src/session/sdk-adapter.ts`; a new package needing the model routes through the `@nightcore/engine` façade. | ✅ active | enforced by lint (`no-restricted-imports`, `layer-rank`) |
| D-004 | 2026-06-27 | Rust core god-file decomposition: `m2/` renamed to `orchestration/`, Tauri handlers lifted to `commands/` (the store becomes a pure leaf), and the Insight/Harness/Scorecard trio unified behind a generic `RunStore<T>`. | ✅ active | docs/research/2026-06-27-rust-core-architecture-decomposition.md |
| D-005 | 2026-06-30 | Worktree overhaul: task-scoped worktrees (`nc/<taskId>` branches) with a branch picker plus a standalone manager; merges stay safe abort-not-force with a read-only preview, no AI auto-merge. | ✅ active | docs/research/2026-06-30-worktree-overhaul-build-spec.md |
| D-006 | 2026-06-26 | Open the `TaskKind` enum into a skill/agent registry (Build · Research · TDD · Decompose) as the control-panel keystone; governance is a tiered sandbox with a Core-skills-first posture. | ✅ active | docs/research/2026-06-26-control-panel-roadmap.md |
| D-007 | 2026-07-02 | Ship the full PR system (create · status/finalize/push · address-comments · AI PR-reviewer scan sibling); the reviewer is diff-centric and read-only, posting one atomic human-gated `gh api` review. | ✅ active | docs/research/2026-07-02-pr-system-design.md |
| D-008 | 2026-07-02 | Hardening/scan enforcement tiers: 18 machine-checkable gate modules with deny/ask/allow runtime tiers, a flight-recorder ledger, prompt-injection quarantine, and an opt-in write sandbox, surfaced in a Policy tab. | ✅ active | docs/research/2026-07-02-hardening-module-catalog.md |

Add a new row for every decision; annotate or update any superseded prose in living docs in the same change that records the reversal.
