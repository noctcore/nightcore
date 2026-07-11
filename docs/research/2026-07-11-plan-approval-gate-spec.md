# Spec: T6 — Plan-approval gate (default-on plan-before-code)

**Date:** 2026-07-11
**Status:** decided (grilled 2026-07-11, D2) — build spec; **v0.3 headline lifecycle feature**
**Ticket:** #147 (T6). **Roadmap:** `docs/research/2026-07-11-roadmap-v0.3-v0.5.md` §5 + D2 (§4).

## Decision (D2, grilled 2026-07-11)
**Default-ON for Build-class tasks, with a global setting + a per-task override; never auto-approve on
timeout.** (Rejected: pure per-kind config — more surface, weaker guarantee; opt-in status-quo — not the
headline governed feature. Confidence-adaptive friction is a possible v0.5 refinement, out of scope.)

## Existing machinery (do NOT rebuild — WIRE it)
The plan-approval STAGE already exists:
- A task running in `plan` mode → the agent calls `ExitPlanMode` → surfaces as a parked permission request
  (`sidecar/…`) → task moves to `waiting_approval` with the plan stored.
- `apps/desktop/src-tauri/src/workflow/plan_approval.rs`: `approve_task` (allow + switch the SAME session to
  `acceptEdits` so it builds, task → in_progress), `reject_task` (deny → failed), `refine_task` (deny →
  backlog, plan kept for edits). Each emits `nc:task`.
- The web plan review lives in `apps/web/src/components/board/TaskDetail/` (TaskDetail + TaskDetailFooter).

What's MISSING (what T6 builds): plan mode is **opt-in per task** today. T6 makes it the **default for
Build-class tasks**, adds the override controls, and polishes the plan artifact review.

## Build
1. **Global setting `planGateDefault` (default ON).** Add to the settings contract + Rust settings store +
   the Settings UI. When ON, Build-class tasks default to plan mode at submit.
2. **Default-on wiring at submit.** In the task submit path (`commands/task.rs` + `NewTaskForm`), when the
   task `kind == Build` and the user hasn't overridden, run it in `plan` mode iff `planGateDefault` is on.
   Non-Build kinds (Research/TDD/Decompose) keep their current default (this is "default-on for **Build**").
3. **Per-task override at submit.** A "Plan first" toggle in `NewTaskForm` (defaulting to the resolved
   global/kind default) so a trivial Build task can skip the plan, or any task can force it. The toggle's
   value flows through the submit command to the run's permission mode.
4. **Never auto-approve on timeout (guarantee).** A parked plan waits indefinitely for a human decision —
   audit the park/stream/watchdog paths to confirm NO timeout or idle-deadline path auto-approves or
   auto-fails a `waiting_approval` plan (the idle/stuck-stream watchdog must EXCLUDE waiting_approval). Add a
   test pinning this.
5. **Plan-review UX polish.** Render the stored plan clearly in TaskDetail; ensure approve / refine
   (reject-with-feedback — the feedback text re-enters the SAME session as the refinement prompt) / reject
   are all surfaced with clear affordances. `refine_task` keeps the plan for edits — wire the feedback field.

## Non-goals (v0.5+)
Confidence-adaptive friction (auto-skip the plan for high-confidence/trivial tasks — Devin's model). Per-kind
granular config beyond "Build defaults on" (the override toggle covers the escape-hatch need).

## Security / correctness notes
- The plan is agent output shown for human review — no execution from the plan text itself; approval switches
  the session to `acceptEdits` (already the machinery). No new trust boundary.
- `waiting_approval` must survive app restart the same way other parked states do (verify the store persists
  the plan + parked request, or that a restart cleanly re-surfaces the gate).

## How to verify
- A Build task submitted with the default ON runs plan-first → `waiting_approval` → approve builds it in the
  same session; refine sends it back with feedback; reject fails it.
- A Build task with the per-task toggle OFF runs straight through (no plan gate).
- `planGateDefault` OFF → Build tasks run straight through unless per-task forced.
- The stuck-stream/idle watchdog never auto-resolves a `waiting_approval` plan (test).
- Gates: `bun run lint`/`lint:meta`/`test:node`, web `typecheck`+`test`; `cargo fmt`/`clippy`/`test`.
