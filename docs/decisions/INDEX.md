# Nightcore Decision Register

The single canonical list of architectural decisions and their status. When a decision is reversed, set the old row to **superseded** and link the doc that supersedes it IN THE SAME CHANGE — never leave contradictory prose in living docs (`AGENTS.md`, `docs/architecture.md`, code comments). Each new decision also gets a dated `docs/<category>/YYYY-MM-DD-<slug>.md` with the standard header (Date / Lens / Scope / Baseline).

Status legend: ✅ active · ⛔ superseded

| ID | Date | Decision | Status | Source / Supersedes |
|----|------|----------|--------|---------------------|
| D-001 | 2026-06-23 | The user's installed `claude` binary is a required prereq; it is NOT bundled. | ✅ active | docs/arch |
| D-002 | 2026-06-24 | Remove `@nightcore/tools` + `@nightcore/mcp`; rely on Claude's native tools + permission model. MCP is UI-configurable via the SDK `Options.mcpServers`, not in-code. | ✅ active | supersedes the earlier "parked seam, don't delete" |
| D-003 | — | The Claude Agent SDK runtime is confined to `packages/engine/src/sdk-adapter.ts`; a new package needing the model routes through the `@nightcore/engine` façade. | ✅ active | enforced by lint (`no-restricted-imports`, `layer-rank`) |

Add a new row for every decision; annotate or update any superseded prose in living docs in the same change that records the reversal.
