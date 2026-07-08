# Research: Port Boringstack Utils/Data Layer Patterns to Nightcore

**Date:** 2026-07-09
**Agent:** kirei
**Status:** complete

## Problem
Investigate porting "boringstack" patterns (queries/mutations style data separation + colocated pure helpers) into nightcore's web app while respecting nightcore's existing conventions (dotted role sidecars like `foo.hooks.ts`, kebab domain modules like `prreview-lifecycle.ts`, `lib/` as cross-feature pure leaf). Scope: apps/web/src + packages/eslint-plugin + tools/lint-meta. Include data layer refactors for maintainability. Formalize `.utils.ts` (pure) + `.utils.test.ts` as recommended sibling. Propose 4-6 dep-ordered phases + 1-2 new lint-meta rules. Full execution via kirei-build/forge with verification gates.

## Root Cause
Pure, framework-free logic (derivations, formatters, folds, counts, normalizers) is sometimes colocated inside stateful `.hooks.ts` files (Board/Board.hooks.ts, WorktreeSwitcher/WorktreeSwitcher.hooks.ts) or duplicated across domain modules (local `countOpen` in two prreview-*.ts files), despite excellent prior factoring (lib/scan-run/*, scan-family-parity, feature-root kebab modules). No formal `.utils.ts` convention or enforcement exists, so god files grow, isolated testing is harder, and duplication risk increases. Nightcore already sketches `queries|mutations` in `component-architecture.ts` + `max-hooks-per-file.ts` but does not use them; the adapted pattern is `.utils.ts` per user decision.

Evidence chain:
- `apps/web/src/components/board/Board/Board.hooks.ts:24` defines+exports `computeBlockedIds`, `groupTasksByColumn`, `matchesQuery`, `isGhostWorktree` (pure); tests in `Board.test.tsx` import them; `Board/index.ts:2` reexports `groupTasksByColumn`.
- `apps/web/src/components/board/WorktreeSwitcher/WorktreeSwitcher.hooks.ts:27` exports `filterTasksByWorktree` (pure, used by Board.hooks via barrel + tested); also `partitionWorktreeTabs`, `summarizeCollapsed`, `COLLAPSE_THRESHOLD`, and several private pure helpers.
- `apps/web/src/components/prreview/prreview-lifecycle.ts:162` and `prreview-timeline.ts:10` each define a private `countOpen`; `lib/scan-run/results.ts:49` already exports the generic `countOpenItems<Item extends {status:string}>`.
- No `**/*.utils.ts` in `apps/web/src` (grep confirmed); AGENTS.md and web/AGENTS.md do not document the sibling; `component-architecture.ts:103` only recognizes `queries|mutations|hooks`.
- `web-file-size-ratchet` and component rules already police size/anatomy, but do not yet drive the pure-helper split.

## Evidence
- `apps/web/AGENTS.md:1` (Folder-per-component) and :20 (Feature-root modules, sidecars & hooks) describe the sibling grammar and kebab modules but omit `.utils`.
- `packages/eslint-plugin/src/utils/component-architecture.ts:103` — `isHookBucketFile` regex + max-hooks rule tests reference `.util.ts` (note singular) only as a negative case.
- `tools/lint-meta/rules/web-file-size-ratchet.ts:38` + baseline — several mixed files are near/over 400; extraction will produce shrink opportunities.
- `tools/lint-meta/registry.ts` + `rules/ui-primitive-shape.ts` — model for adding sibling-enforcement rules.
- `components/prreview/prreview-compose.ts`, `prreview-stream.ts`, `lib/formatters.ts`, `lib/transcript.ts`, `lib/scan-run/*.ts` — examples of already-good pure modules living at feature-root (kebab) or `lib/`.
- Barrel discipline: `WorktreeSwitcher/index.ts:3` and `Board/index.ts` reexport pures today; consumers reach via barrel or relative in same feature (allowed).

## Solution Options

### Option A — Introduce colocated *.utils.ts + *.utils.test.ts (recommended)
- Pure helpers move from big `.hooks.ts`/lifecycle/domain `.ts` into sibling `<Name>.utils.ts` (component folders) or `<feature>-<concern>.utils.ts` / `<concern>.utils.ts` (feature root kebab modules).
- `.utils.test.ts(x)` for pure vitest unit tests.
- Update docs (AGENTS), component-architecture helper, add two lint-meta rules.
- Pros: matches user decision, uses nightcore style (dotted role), keeps `lib/` for cross-feature, improves testability, reduces god risk without new folders.
- Cons: new files per adoption; requires careful barrel preservation.

### Option B — Adopt queries/mutations terminology for data
- Use `.queries.ts`/`.mutations.ts` (as partially wired) for data accessors + side-effect actions.
- Pros: closer to "boringstack" name.
- Cons: conflicts with nightcore's "no role suffix for compound domain modules" grammar; would require changes to `isHookBucketFile` + max-hooks docs; user explicitly chose `.utils.ts` + "adapt queries/mutations idea" as extract pure + data sep.

### Option C — Only lib/ extractions, no colocated utils
- Push everything possible into `lib/`.
- Cons: violates "lib/ is leaf below rendering" + no-cross-feature intent for feature-private pure; loses colocation benefit.

## Recommended Approach
Option A. Use dotted-role `.utils.ts` (pure) + `.utils.test.ts` colocated with components and kebab domain modules. Keep `lib/` for true cross-feature (scan-run, formatters, useScan*). Add two lint-meta rules to make the standard mechanical. Phases ordered so docs/rules land before moves, with verification gates.

## Files to Modify
- `AGENTS.md` (root) — add new lint-meta rules to enforced list; cross-ref the anatomy convention.
- `apps/web/AGENTS.md` — formalize `.utils.ts` (pure helpers) + `.utils.test.ts` as recommended sibling in "Folder-per-component" and "Feature-root modules, sidecars & hooks" sections. Note purity contract (no React, no bridge, no feature imports except relative types).
- `packages/eslint-plugin/src/utils/component-architecture.ts` — add `isUtilsFile` (or `isPureUtilsFile`), update comments, adjust max-hooks test fixture name from `.util.ts` → `.utils.ts` and add positive case.
- `packages/eslint-plugin/tests/rules/max-hooks-per-file.test.ts` — sync fixture name.
- `tools/lint-meta/rules/canonical-helpers-single-home.ts` (new) — implement rule.
- `tools/lint-meta/rules/test-sibling-enforcement.ts` (new) — implement rule (modeled on ui-primitive-shape).
- `tools/lint-meta/registry.ts` — register the two new rules.
- `tools/lint-meta/README.md` — document the two new rules in the table.
- `apps/web/src/components/board/Board/Board.hooks.ts` — remove pure fns; import from `./Board.utils`.
- `apps/web/src/components/board/Board/Board.utils.ts` (new) — the extracted pures with docs.
- `apps/web/src/components/board/Board/Board.utils.test.tsx` (new) — pure unit tests moved from Board.test.tsx.
- `apps/web/src/components/board/Board/index.ts` — reexport `groupTasksByColumn` (and type) sourcing from `./Board.utils`.
- `apps/web/src/components/board/Board/Board.test.tsx` — remove pure-unit tests/imports (keep component + story tests).
- `apps/web/src/components/board/WorktreeSwitcher/WorktreeSwitcher.hooks.ts` — remove pure fns; import from `./WorktreeSwitcher.utils`.
- `apps/web/src/components/board/WorktreeSwitcher/WorktreeSwitcher.utils.ts` (new) — extracted pures (filterTasksByWorktree, partition..., summarizeCollapsed, COLLAPSE_THRESHOLD, isRunning, branchesFromTasks, synthWorktree, isDiverged, buildSelectRows, ...).
- `apps/web/src/components/board/WorktreeSwitcher/WorktreeSwitcher.utils.test.tsx` (new) — pure tests moved/adapted from WorktreeSwitcher.test.tsx.
- `apps/web/src/components/board/WorktreeSwitcher/index.ts` — update reexports to source from `.utils`.
- `apps/web/src/components/board/WorktreeSwitcher/WorktreeSwitcher.test.tsx` — update pure imports to `.utils`; keep component tests.
- `apps/web/src/components/board/WorktreeSwitcher/WorktreeSwitcher.tsx` — update import of `partitionWorktreeTabs` (from `.utils` or keep re-export if preferred).
- `apps/web/src/components/prreview/prreview-lifecycle.ts` — delete local `countOpen`; use `countOpenItems` from `@/lib/scan-run`.
- `apps/web/src/components/prreview/prreview-timeline.ts` — same dedup.
- (Optional in polish) `apps/web/src/components/board/session-stream.ts` — consider moving closeOpenText/classifyPhase/... to `session-stream.utils.ts` if it improves readability (lower priority).
- Any callers of moved symbols inside same feature update relative imports (barrel users unaffected).
- After shrinks: `tools/lint-meta/baselines/web-file-size-ratchet.json` may need tightening via `bun run lint:meta -- --update-baseline`.

Reference files (do not modify in this scope):
- `apps/web/src/lib/scan-run/results.ts` (source of truth for countOpenItems + other shared scan pures).
- `apps/web/src/lib/formatters.ts`, `lib/transcript.ts` (canonical pure homes in lib/).
- `apps/web/src/components/prreview/prreview-compose.ts`, `prreview-stream.ts` (good examples of feature-root pure domain modules).
- `tools/lint-meta/rules/ui-primitive-shape.ts`, `web-file-size-ratchet.ts` (models for new rules).

## Risks & Gotchas
- Barrel contract: must preserve public exports from WorktreeSwitcher/index.ts and Board/index.ts or every consumer (including cross-feature via app composition root) breaks.
- Purity invariant: `.utils.ts` must not import React, motion, components/* (except sibling .types.ts for types), or @tauri. Enforced by review + future lint if added; `lib/` purity rule (`lib/**` MUST NOT import `@/components/**`) does not apply to feature-colocated utils.
- No weakening of: `no-cross-feature-imports`, `max-props-per-component`, `enforce-context-consumption`, `context-value-must-be-memoized`, `no-prop-drilling`, `layer-rank`, `scan-family-parity`, `web-file-size-ratchet`, `component-folder-structure`.
- New lint-meta must be strict from day one (no baselines) and not flag legitimate pre-adoption code (e.g. pure fns in a .hooks.ts that has not yet grown a sibling .utils.ts). Design the rules to trigger on adoption sites or use opt-in signals.
- Test sibling files are excluded from size ratchet (already: `.test.` filter in web-file-size-ratchet).
- Date-sensitive: update AGENTS in same change that adds wired rules (agent-contract-parity only covers nightcore/* eslint rules; lint-meta still need manual doc in the list).
- Size ratchet self-tightening: after extraction shrinks a grandfathered file below cap or 15% under frozen, the baseline entry itself becomes a violation until `--update-baseline`.
- Windows path/glob edge cases in new rules (follow patterns in ui-primitive-shape + web-file-size-ratchet; use posix normalization).
- Keep `lib/` as leaf: feature-private pure belongs in feature .utils; only truly shared goes to `lib/`.

## How to Verify
1. `bun run lint` (rebuilds plugin first) — zero errors, new rules registered and passing.
2. `bun run typecheck`
3. `bun run test:web` (vitest) — all existing + new .utils.test pass; component stories continue to render.
4. `bun run lint:meta` — no violations; after any shrink, confirm baseline tightening command is used if needed.
5. Manual: confirm no pure fns remain in the source .hooks.ts (except hooks); barrel still exports same surface; imports inside feature are relative; `lib/` untouched.
6. Between phases: after each kirei-build/forge phase, run the above gates before next phase.

## Open Questions
- Should `.utils.ts` be allowed inside `components/ui/` for complex presentational utils, or keep ui flat? (ui has its own shape rule.)
- Do we want an eslint rule (in addition to lint-meta) that bans `use*` exports from `*.utils.ts`? (Enforceable in eslint-plugin.)
- Scope of "canonical-helpers-single-home": only under `components/` + feature-root kebab, or also lib/? Start narrow.
- Any other immediate high-value pure extractions discovered during phase 2-3 execution that should be pulled into phase 4/5?
