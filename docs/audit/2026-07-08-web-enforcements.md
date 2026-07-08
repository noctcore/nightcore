# Audit Findings — web-enforcements

**Date:** 2026-07-08
**Agent:** kirei-refactor (kirei-audit slice)
**Scope:** packages/eslint-plugin (entire), tools/lint-meta (entire), apps/web/src/lib/generated (entire)
**Category:** audit

---

## Summary

This slice audited the **enforcement layer** of the Nightcore architecture: the 12 custom ESLint rules in `@nightcore/eslint-plugin`, the 18 lint-meta rules that enforce cross-file contracts, and the 76 ts-rs generated contract files.

**Overall assessment:** The enforcers are structurally sound with consistent patterns, zero `any` types, and proper generated-file hygiene. However, **tools/lint-meta has zero unit tests** — all 18 rules are only exercised by running against the live tree. Several AGENTS.md-documented rules lack corresponding implementation documentation. Dead `RULE_NAME` exports exist across all 12 eslint-plugin rules.

**Highest-leverage findings:**
1. **No tests for lint-meta** (18 rules, 0 test files) — high risk, medium effort
2. **Dead `RULE_NAME` exports** (12 instances) — low risk, trivial effort
3. **AGENTS.md coverage gaps** for 4 lint-meta rules (`no-cloned-component-folders`, `scan-family-parity`, `agent-contract-parity`, `codegen-drift`) — the self-referential `agent-contract-parity` rule would catch missing plugin rules but not its own documentation gap
4. **Complex `manifestOffenses()`** (~70 LOC with nested loops) in rust-module-shape.ts — correctness-critical, hard to reason about

---

## Dead Code to Remove

| File | What | Risk |
|------|------|------|
| `packages/eslint-plugin/src/rules/component-folder-structure.ts:14` | `export const RULE_NAME = 'component-folder-structure'` — only used internally for `name:` field | Low |
| `packages/eslint-plugin/src/rules/no-state-in-component-body.ts:7` | `export const RULE_NAME = 'no-state-in-component-body'` — never imported | Low |
| `packages/eslint-plugin/src/rules/no-cross-feature-imports.ts:9` | `export const RULE_NAME = 'no-cross-feature-imports'` — never imported | Low |
| `packages/eslint-plugin/src/rules/max-hooks-per-file.ts:7` | `export const RULE_NAME = 'max-hooks-per-file'` — never imported | Low |
| `packages/eslint-plugin/src/rules/max-hook-return-surface.ts:7` | `export const RULE_NAME = 'max-hook-return-surface'` — never imported | Low |
| `packages/eslint-plugin/src/rules/max-props-per-component.ts:7` | `export const RULE_NAME = 'max-props-per-component'` — never imported | Low |
| `packages/eslint-plugin/src/rules/no-prop-drilling.ts:7` | `export const RULE_NAME = 'no-prop-drilling'` — never imported | Low |
| `packages/eslint-plugin/src/rules/enforce-context-consumption.ts:11` | `export const RULE_NAME = 'enforce-context-consumption'` — never imported | Low |
| `packages/eslint-plugin/src/rules/context-value-must-be-memoized.ts:5` | `export const RULE_NAME = 'context-value-must-be-memoized'` — never imported | Low |
| `packages/eslint-plugin/src/rules/no-deep-package-imports.ts:5` | `export const RULE_NAME = 'no-deep-package-imports'` — never imported | Low |
| `packages/eslint-plugin/src/rules/wire-message-naming.ts:5` | `export const RULE_NAME = 'wire-message-naming'` — never imported | Low |
| `packages/eslint-plugin/src/rules/zod-schema-naming.ts:5` | `export const RULE_NAME = 'zod-schema-naming'` — never imported | Low |

**Fix:** Change `export const RULE_NAME` → `const RULE_NAME` in all 12 files (or remove entirely and inline the string literal).

---

## Duplication to Consolidate

**None significant between eslint-plugin and lint-meta** — they operate in disjoint domains (AST rules vs cross-file contracts) and share no code.

**Minor internal patterns (not worth extracting):**
- `getPropsPattern()` logic appears in both `no-prop-drilling.ts:47` and `enforce-context-consumption.ts:100` — both check for `*Props`-annotated first param. They are ~15 lines each and serve slightly different callers (one for forward detection, one for re-thread detection). Extracting would add indirection for negligible gain.
- `stripLineComments`/`stripCfgTestModBlocks` are in `rust-source.ts` and reused by 4 rust-* rules — **correct consolidation**, not duplication.

---

## Abstractions to Add

### Missing: unit test harness for lint-meta rules

**Currently:** Every `IMetaRule` is only exercised by `cli.ts` running against the live repo. No isolated tests exist.

**Should be:** A test utility (e.g., `tools/lint-meta/tests/rule-tester.ts`) that constructs a fake `IMetaCtx` (in-memory read/exists/glob/exec) so each rule can be unit-tested with synthetic trees. Pattern: similar to eslint-plugin's `ruleTester.ts`.

**Files:** `tools/lint-meta/` — new `tests/` directory + harness

---

## Abstractions to Remove

**None.** No premature abstractions detected. `createRule` wrapper is a thin, justified cosmetic layer. `component-architecture.ts` is a legitimate shared utility with 8 focused helpers used by 7 rules.

---

## Files to Split

| File | Lines | Problem | Split into |
|------|-------|---------|------------|
| `tools/lint-meta/rules/rust-module-shape.ts` | ~230 | `manifestOffenses()` (~70 LOC) is a hand-written brace-depth parser mixed with rule definition | Keep rule in place; extract `manifestOffenses` + `countCodeLines` to `rust-source.ts` (or a new `rust-manifest.ts`) if more manifest logic appears |
| `tools/lint-meta/rules/rust-layer-rank.ts` | ~180 (est.) | Large RANK/FACADE tables + seam logic + facade resolution | Could split tables to a `rust-ranks.ts` data module; not urgent |

---

## Implementation Order

1. **Remove dead `RULE_NAME` exports** — pure local change, zero risk, XS effort
2. **Add lint-meta test harness + smoke tests** — unblocks safe refactoring of complex rules, S effort
3. **Document missing AGENTS.md entries** for `no-cloned-component-folders`, `scan-family-parity`, `agent-contract-parity`, `codegen-drift` — or explicitly decide they are "implementation detail" not user-facing contracts, XS effort
4. **Refactor `manifestOffenses()` for clarity** (optional) — only if new manifest rules are added; M effort, medium risk (brace parser is subtle)

---

## Effort Estimates

| Change | Effort | Risk | Value |
|--------|--------|------|-------|
| Remove 12 dead `RULE_NAME` exports | XS | Low | Low (cleanup) |
| Add lint-meta test harness | S | Low | High (confidence in enforcers) |
| Document AGENTS gaps (or carve out) | XS | Low | Medium (self-consistency) |
| Extract manifestOffenses to rust-source | S | Medium | Low (premature unless more logic added) |
| Add pinning test for generated contracts | S | Low | Medium (detect hand-edits) |

---

## What NOT to Refactor

- **Generated files** (`apps/web/src/lib/generated/**`): purely ts-rs output. The "Do not edit" header is present on all 76 files. Do not suggest code changes.
- **`layerRules` export in `tools/lint-meta/index.mjs`**: this is a deliberate secondary export (ESLint `no-restricted-imports` blocks) consumed by root `eslint.config.mjs`. It is not part of the CLI rule system and is documented as such in README.md. Do not conflate it with `META_RULES`.
- **Rust-source utilities** (`stripLineComments`, `stripCfgTestModBlocks`): already shared correctly across 4 rust-* rules. No duplication to fix.
- **`console.error` in lint-meta rules**: intentional for grandfathering/advisory logging (see `web-file-size-ratchet.ts:92`, `rust-module-shape.ts:198-229`). Not a bug.

---

## Coverage Gaps vs AGENTS.md Contracts

| AGENTS.md Rule | Implemented? | Documented in AGENTS.md? | Notes |
|----------------|--------------|---------------------------|-------|
| `nightcore/component-folder-structure` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/no-state-in-component-body` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/no-cross-feature-imports` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/max-hooks-per-file` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/max-hook-return-surface` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/max-props-per-component` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/no-prop-drilling` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/enforce-context-consumption` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/context-value-must-be-memoized` | ✅ eslint-plugin | ✅ apps/web/AGENTS.md | |
| `nightcore/no-deep-package-imports` | ✅ eslint-plugin | ✅ root AGENTS.md | |
| `nightcore/zod-schema-naming` | ✅ eslint-plugin | ✅ root AGENTS.md | |
| `nightcore/wire-message-naming` | ✅ eslint-plugin | ✅ root AGENTS.md | |
| `package-shape` | ✅ lint-meta | ✅ root AGENTS.md | |
| `workspace-graph-parity` | ✅ lint-meta | ✅ root AGENTS.md | |
| `layer-rank` | ✅ lint-meta | ✅ root AGENTS.md | |
| `no-warn-severity` | ✅ lint-meta | ✅ root AGENTS.md | |
| `test-workspace-enrollment` | ✅ lint-meta | ✅ root AGENTS.md | |
| `test-runner-segregation` | ✅ lint-meta | ✅ root AGENTS.md | |
| `decision-register-integrity` | ✅ lint-meta | ✅ root AGENTS.md | |
| `agents-doc-presence` | ✅ lint-meta | ✅ root AGENTS.md | |
| `ui-primitive-shape` | ✅ lint-meta | ✅ root AGENTS.md | |
| `rust-module-shape` | ✅ lint-meta | ✅ root AGENTS.md | |
| `rust-layer-rank` | ✅ lint-meta | ✅ root AGENTS.md | |
| `rust-command-placement` | ✅ lint-meta | ✅ root AGENTS.md | |
| `rust-engine-seam` | ✅ lint-meta | ✅ root AGENTS.md | |
| `no-cloned-component-folders` | ✅ lint-meta | ❌ **NOT DOCUMENTED** | Issue #54; in README.md but not AGENTS.md |
| `scan-family-parity` | ✅ lint-meta | ❌ **NOT DOCUMENTED** | Issue #50 related; in README.md but not AGENTS.md |
| `agent-contract-parity` | ✅ lint-meta | ❌ **NOT DOCUMENTED** | Self-referential: enforces docs mention rules, but is itself undocumented |
| `codegen-drift` | ✅ lint-meta | ❌ **NOT DOCUMENTED** | Indirectly referenced ("regenerate, never hand-edit") but no rule name |
| `web-file-size-ratchet` | ✅ lint-meta | ⚠️ Indirect | apps/web/AGENTS.md describes the 400-line cap + ratchet but doesn't name the rule |

**Observation:** `agent-contract-parity` only scans the **plugin's `recommended.ts`** for `'nightcore/*'` patterns. It does **not** check lint-meta rules. So the 4 undocumented lint-meta rules above are invisible to it. This is correct per the rule's stated purpose ("every wired `nightcore/*` lint rule"), but means AGENTS.md drift for lint-meta rules is not mechanically enforced.

---

## Self-Audit: Would Enforcers Pass Their Own Rules?

### packages/eslint-plugin

- **Import ordering:** Source uses `import type` then bare imports, then blank line, then relative — matches `simple-import-sort` groups in eslint.config.mjs. ✅
- **No deep package imports:** The plugin's own source imports only from `./utils/*` (relative) and `@typescript-eslint/utils` (third-party). No `@nightcore/*` imports at all. ✅
- **No `any`:** Zero `any` type annotations in `src/`. ✅
- **createRule usage:** All 12 rules use `createRule(...)`. ✅

### tools/lint-meta

- **No `any`:** Zero `any` in `*.ts` source (only in JSDoc `@ts-check` implicit types). ✅
- **Layer rules (index.mjs):** The `layerRules` export is a flat-config fragment, not subject to eslint-plugin rules (it's `.mjs`, consumed by root config). Not in scope.
- **README vs registry:** README.md table lists all 18 rules; `registry.ts` exports 18. They match. ✅

### apps/web/src/lib/generated

- All 76 files begin with `// This file was generated by [ts-rs]... Do not edit this file manually.`
- No "hand" / "manual" / "edit" markers found in content.
- No evidence of hand-edits. ✅

---

## Best Practice Gaps

| Gap | Location | Severity | Fix |
|-----|----------|----------|-----|
| **No unit tests for lint-meta** | `tools/lint-meta/` | High | Add `tests/` + fake `IMetaCtx` harness. At minimum, a smoke test that runs each rule against a minimal synthetic tree and asserts zero violations on a clean mock. |
| **Magic numbers for caps are defined but not cross-checked** | `web-file-size-ratchet.ts:39` (CAP=400), `eslint.config.mjs:420` (max-lines:500), `rust-module-shape.ts:46` (HARD_CAP=400) | Medium | Consider a shared constant or at least a comment linking the two caps. Currently documented in prose only. |
| **agent-contract-parity is self-exempt** | `agent-contract-parity.ts` | Low | The rule enforces that wired plugin rules appear in AGENTS.md. It is itself a lint-meta rule, not a `nightcore/*` plugin rule, so it correctly doesn't check itself. Document this carve-out or add a separate "meta-rules documented" check if desired. |
| **No pinning test for generated file count** | N/A | Low | A simple test asserting "76 generated files exist" would detect accidental deletion or incomplete codegen. Not critical (cargo test + codegen-drift cover content drift). |

---

## Notes on Generated Contracts

- `apps/web/src/lib/generated/` (76 `*.ts`): Pure ts-rs output. Every file carries the standard header. **Do not hand-edit.** The audit confirms no hand-edit markers.
- Contract completeness is outside this slice's scope (the contracts package and Rust side are other slices). Pinning tests for field-absent behavior live in `packages/contracts/src/*.test.ts` (e.g., `codegen-conformance.test.ts`).
- If a generated file is **missing** a field that the source struct has, that is a codegen-drift or ts-rs issue — flagged by `cargo test` (test:rust), not by lint-meta's `codegen-drift` (which only checks zod→Rust direction).

---

## Files Examined (counts)

- `packages/eslint-plugin/src/`: 15 files (index.ts, configs/, rules/ 12, utils/ 2)
- `packages/eslint-plugin/tests/`: 14 files (12 rule tests + test-utils + fixtures tree)
- `tools/lint-meta/`: 24 files (18 rules + cli.ts + registry.ts + types.ts + baseline.ts + rust-source.ts + index.mjs + README.md + 2 baselines)
- `apps/web/src/lib/generated/`: 76 generated `*.ts` files
- Supporting: root `AGENTS.md`, `apps/web/AGENTS.md`, `eslint.config.mjs`, root `package.json`, `docs/decisions/INDEX.md`

**Total audited:** ~145 files (as scoped).

---

*End of findings.*

---
## KIREI-REFACTOR HANDOFF

**Plan:** docs/audit/2026-07-08-web-enforcements.md

**Implementation order:**
1. Remove dead `RULE_NAME` exports (12 instances) — `packages/eslint-plugin/src/rules/*.ts:5-14` — change `export const RULE_NAME` to `const RULE_NAME` — Effort: XS
2. Add lint-meta unit test harness — `tools/lint-meta/` — create `tests/` + fake `IMetaCtx` harness for isolated rule testing — Effort: S
3. Document AGENTS.md gaps (or carve-out) — root `AGENTS.md` — add entries for `no-cloned-component-folders`, `scan-family-parity`, `agent-contract-parity`, `codegen-drift` or document why exempt — Effort: XS
4. (Optional) Extract `manifestOffenses()` for clarity — `tools/lint-meta/rules/rust-module-shape.ts:112` — if more manifest logic is added — Effort: S/M

**Execute complexity per change:**
- Steps 1, 3: SIMPLE → kirei-build (local edits, no ordering dependencies)
- Step 2: COMPLEX → kirei-forge (new test infrastructure, needs design of fake ctx)
- Step 4: SIMPLE → kirei-build (only if pursued)

**High-risk changes:**
- None in this slice. All changes are low-risk cleanup or additive tests.
- `manifestOffenses()` brace-depth parser is correctness-critical but currently stable; touching it requires careful test coverage first.

**Verification:**
- Typecheck must pass after each step (`bun run typecheck`)
- Run `bun run test:plugin` after any eslint-plugin changes
- Run `bun run lint:meta` to verify no regressions in meta rules
- Run `bun run lint` (full) to ensure plugin rebuild + meta both stay green

**Counts by category (from full taxonomy run):**
- Dead code: 12 (RULE_NAME exports)
- Duplication: 0 significant (minor internal patterns not worth extracting)
- God files / complexity: 2 (rust-module-shape.ts ~230 LOC with 70-line manifestOffenses(); rust-layer-rank.ts ~180 LOC)
- Abstraction quality: 1 missing (lint-meta test harness); 0 over-abstractions
- Consistency / conventions: 4 AGENTS.md gaps; 1 self-referential documentation gap (agent-contract-parity)
- Best practice gaps: 1 HIGH (no lint-meta tests); 3 MEDIUM/LOW (magic caps, self-exempt rule, no generated pinning test)

**Top 10 findings (file:line, category, severity, effort, risk, one-line fix):**
1. `tools/lint-meta/` (all 18 rules) — 6 — HIGH — S — LOW — Add unit test harness with fake IMetaCtx; currently 0 tests
2. `packages/eslint-plugin/src/rules/component-folder-structure.ts:14` — 1 — LOW — XS — LOW — `export const RULE_NAME` → `const RULE_NAME` (same for 11 siblings)
3. `tools/lint-meta/rules/no-cloned-component-folders.ts:1` — 5 — MEDIUM — XS — LOW — Document in root AGENTS.md or add carve-out note
4. `tools/lint-meta/rules/scan-family-parity.ts:1` — 5 — MEDIUM — XS — LOW — Document in root AGENTS.md or add carve-out note
5. `tools/lint-meta/rules/agent-contract-parity.ts:1` — 5 — MEDIUM — XS — LOW — Document in root AGENTS.md; rule is self-exempt by design
6. `tools/lint-meta/rules/codegen-drift.ts:1` — 5 — LOW — XS — LOW — Document or note indirect coverage via "regenerate, never hand-edit"
7. `tools/lint-meta/rules/rust-module-shape.ts:112` — 3 — MEDIUM — S — MEDIUM — Extract manifestOffenses() if more manifest logic added
8. `packages/eslint-plugin/src/rules/no-prop-drilling.ts:47` + `enforce-context-consumption.ts:100` — 2 — LOW — XS — LOW — (Optional) minor getPropsPattern duplication; not worth extracting
9. `eslint.config.mjs:420` + `web-file-size-ratchet.ts:39` + `rust-module-shape.ts:46` — 6 — LOW — XS — LOW — Add cross-reference comment linking the 400/500 caps
10. `apps/web/src/lib/generated/` (76 files) — 6 — LOW — XS — LOW — (Optional) add pinning test for file count; not critical

**Self-consistency issues:**
- `agent-contract-parity` enforces that wired `nightcore/*` plugin rules appear in AGENTS.md. It correctly does NOT check lint-meta rules (different namespace). This means 4 lint-meta rules can drift from AGENTS.md without mechanical detection.
- The enforcers themselves pass their own rules (no `any`, correct import ordering, consistent createRule usage, no deep imports within plugin source).

**Gaps in enforcement coverage of documented contracts:**
- All 12 plugin rules are wired and have corresponding AGENTS.md prose (via root + apps/web/AGENTS.md split).
- 18 lint-meta rules exist; 14 are named in root AGENTS.md; 4 are undocumented (`no-cloned-component-folders`, `scan-family-parity`, `agent-contract-parity`, `codegen-drift`).
- `web-file-size-ratchet` is described in apps/web/AGENTS.md (400-line cap + ratchet) but not named as a rule.

**Note:** This audit was scoped to enforcements only (packages/eslint-plugin, tools/lint-meta, apps/web/src/lib/generated). Other slices own ui/, board/, prreview/, harness-insight/, feature-lib/, and root lib/ non-generated.

---
