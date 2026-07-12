# Research: Settings information-architecture audit

**Date:** 2026-07-12
**Agent:** kirei-ui (read-only; no code changed)
**Status:** advisory

## 0. Bottom line

Settings (`apps/web/src/components/settings/SettingsView/SettingsView.tsx`) is *not* a flat
pile — it already has a 4-group / 9-page left-nav from a prior reorg. The real problems:

1. **Two pages genuinely mix unrelated concerns** — `providers` (default-provider picker +
   MCP server CRUD) and `hooks` (desktop notifications + GitHub issue-sync writeback). Split both.
2. **Several real, persisted settings have *no* presence in Settings at all** — they live only in
   board-header gear-popovers or a sidebar-footer widget. This is the bigger discoverability gap,
   and includes one outright dead end (usage meter has no visible "disable").

The Rust `Settings` struct (`store/settings/model.rs`) is one flat struct patched via one
`SettingsPatch`/`patchGlobal`/`patchScoped` seam — **every regrouping below is a pure web-tier
move**, not a schema change (one caveat: board appearance is project-only).

## 1. Current IA map

Nav: `SettingsView.tsx:48-78` (`NAV_GROUPS`), headers `:88-98`. 9 pages, ~13 cards, ~35 controls.

| Group | Page | Card(s) | # | Notes |
|---|---|---|---|---|
| AGENTS | Models & runs | `settings-cards.tsx:101-194` (model/reasoning, parallelism, limits) | 5 | Coherent |
| AGENTS | Permissions | `settings-cards.tsx:195-249` (tool perms, plan-gate) | 3 | Coherent |
| AGENTS | Constitution | `ConstitutionCard.tsx` | 1 | Fine — needs its own page |
| WORKTREES | Git worktrees | `settings-cards.tsx:255-305` | 3 | Single-item nav group (odd) |
| INTEGRATIONS | Providers | provider picker (`settings-cards.tsx:308-352`) **+** `McpServersCard.tsx` | 2 + CRUD | **Mixed — split** |
| INTEGRATIONS | Hooks & notifications | `settings-notification-cards.tsx` (4) **+** `settings-github-cards.tsx` (2) | 6 | **Mixed — split** |
| SYSTEM | Interface | `settings-interface-cards.tsx` (appearance 1 + terminal 6) | 7 | **Overloaded — split**; miscategorized security toggle |
| SYSTEM | Paths | `settings-cards.tsx:358-375` | 2 | Fine |
| SYSTEM | About | `settings-about-cards.tsx` | 4 | Fine |

## 2. Persisted settings that are NOT in Settings at all

All patch the same flat `Settings` struct; they just render from a different component tree.

| Setting | Where it lives | Field |
|---|---|---|
| Auto-commit on verified + usage-pause threshold | board-header Auto Mode gear popover (`AutoModeOptions.tsx`) | `auto_commit_on_verified`, `auto_pause_usage_threshold` |
| Usage meter enable | sidebar-footer widget (`UsageMeter.tsx:24-41`) | `usage_meter_enabled` |
| **Usage meter disable** | **Nowhere** — `disableUsageMeter()` exists (`bridge/commands/usage.ts:45`, `commands/usage.rs:45`) but has **zero web call sites**. Once opted in, no UI path out. | `usage_meter_enabled` |
| Board appearance / background | board-header `BoardBackgroundPanel` | `SettingsOverride.board_appearance`/`board_background` — legitimately project-only (no global counterpart) |
| Terminal "Confined" sticky default | terminal new-tab picker | `terminal_confined_default` |

(Max concurrency is *intentionally* duplicated in Settings + a board-header slider — both write the
same field. The auto-mode/usage cluster is different: no Settings representation at all.)

## 3. Findings, ranked

- **3.1 — HIGH — No way to disable the usage meter once enabled.** `disableUsageMeter` bridge fn
  never called anywhere in `apps/web`. Dead-end UX (Keychain opt-in, no opt-out).
- **3.2 — HIGH — Auto Mode governance has zero Settings presence.** `auto_commit_on_verified` +
  `auto_pause_usage_threshold` reachable only via a board-header gear. Conceptually one "autonomy
  governance" story split across three unrelated surfaces (+ `plan_gate_default`, `usage_meter_enabled`).
- **3.3 — MEDIUM — `providers` mixes provider identity with MCP server administration.** MCP CRUD
  (persists env/headers plaintext, `model.rs:74-78`) deserves its own nav entry.
- **3.4 — MEDIUM — `hooks` mixes desktop notifications with GitHub writeback.** The GitHub issue-sync
  toggle mutates a (often public) repo; it shares a page with 4 desktop-notification toggles.
- **3.5 — MEDIUM — Interface→Terminal card does too much + miscategorizes a security toggle.** 6 rows
  incl. "Skip Claude permissions (YOLO)" (strips all permission prompts) under a page whose subtitle is
  "LAYOUT". YOLO belongs near `permission_mode`/`sandbox_sessions` on Permissions. Terminal warrants its
  own page.
- **3.6 — LOW — Single-item nav group** (WORKTREES has one child).
- **3.7 — LOW — Read-only Provider inspector overlaps the editable MCP list** (no cross-link).
- **3.8 — MEDIUM (a11y) — `Segmented` has no group/selection semantics.** Plain `<button>`s, no
  `role="radiogroup"`/`radio`, no `aria-checked`. Used 6× in Settings + scope tabs + Constitution tabs.
  Shared primitive → fix once, fixes everywhere (WCAG 4.1.2 / 1.3.1). `SidebarLayoutPicker` does it right.
- **3.9 — Correctly separated (no change):** the injection-quarantine / allow-ask-deny Policy surface
  lives in the Harden stage's `HarnessView`, not global Settings — right call (per-project governance).

## 4. Schema coupling

`Settings` is one flat struct (`model.rs:22-248`); `SettingsOverride` mirrors the overridable subset;
`SettingsPatch` is the flat wire type. **Every regroup is pure web-tier** — relocate a control + its
`patchGlobal`/`patchScoped` call. One constraint: `board_appearance`/`board_background` are project-only
with no global fallback, so they can't use the existing Global/Project scope toggle as-is — **don't**
pull them into Settings.

## 5. Proposed IA (9→13 pages, 5 groups)

- **AGENTS** — Models & runs, Permissions (+ YOLO toggle moved here), Constitution.
- **AUTOMATION** *(new)* — **Auto Mode** (`auto_commit_on_verified` + plan-gate), **Usage**
  (`usage_meter_enabled` with a real disable + `auto_pause_usage_threshold`). Board-header/sidebar
  widgets become shortcuts INTO these, not the only entry.
- **WORKTREES** — Git worktrees (or fold into AGENTS to kill the single-item group).
- **INTEGRATIONS** — Providers (picker only), **MCP Servers** *(split out)*, **GitHub** *(split out)*,
  Notifications *(renamed, GitHub removed)*.
- **SYSTEM** — Interface (layout only), **Terminal** *(split out)*, Paths, About.

Rationale: group by *task the user is doing*, not by *where the control happened to be built*.

## 6. Effort / slice sketch (all pure web-tier per §4)

1. Split `providers` → `providers` + `mcp-servers` (small).
2. Split `hooks` → `notifications` + `github` (small; `settings-github-cards.tsx` already separate).
3. Split `interface` → `interface` + `terminal`, move YOLO row to `permissions` (small-medium).
4. New `Auto Mode` + `Usage` pages (medium) — **includes the one genuine feature add**: wire a
   `<Toggle>` to the unused `disableUsageMeter` bridge call (fixes 3.1).
5. **Do NOT** move board appearance into Settings (project-only scope constraint; low payoff).
6. `Segmented` a11y fix (small, high-leverage — one shared primitive) — land independently.
7. Every new page follows the `settings-<name>-cards.tsx` sibling pattern (folder-per-component,
   no-cross-feature-import, 400-line ratchet — `settings-cards.tsx` is 379 lines, splitting gives headroom).
