# Dependency Safety Report

**Date:** 2026-08-31
**Agent:** kirei-deps
**Depth:** deep
**Package manager:** bun (JS/TS workspace, bun.lock only — no lockfile conflicts) + cargo (Rust crate, `apps/desktop/src-tauri/`)
**Scope:** direct + transitive, both ecosystems (JS workspace: `apps/*`, `packages/*`; Rust: `apps/desktop/src-tauri/`)

## Summary

**The JS audit gate (`bun run audit` / CI job `bun audit (Bun workspace)`) has been RED on `main` for three consecutive weekly cron runs (2026-08-10, 08-17, 08-24) and every PR check since** — confirmed via `gh run list --workflow=audit.yml`, last green was 2026-08-03. It is failing right now for a good reason (11 new advisories are not yet on the by-id ignore list), but the practical effect is that **every PR is red on an unrelated check**, including the routine Rust dependency-bump PR #464 (`cargo audit` passes, full CI passes, only `bun audit` fails). The Rust side (`cargo audit`) is clean of actual vulnerabilities — only "unmaintained/unsound" warnings, none blocking the gate.

The good news: every one of the 11 new JS advisories, plus all 5 already-ignored ones, resolves via a **pure lockfile refresh** (`bun update`, no `package.json` dependency-version edits) plus **two one-line override lower-bound bumps** already present in `package.json` — no override needs to cross a major, so the `brace-expansion`-breaks-vite trap from #411 does not recur. Rust clears its two ignored advisories (`quick-xml` DoS) the same way: `cargo update` inside `apps/desktop/src-tauri`, zero `Cargo.toml` edits, ~140 crates refreshed, no majors crossed (Tauri core itself is already at the latest 2.11.5).

Recommended next step: land Phase 1 (below) as a single PR via kirei-stitch, then close out the 5 stale ignore-list entries in `scripts/audit.ts` in the same PR (the script hard-fails if an ignore entry stops matching a live advisory, so this isn't optional once Phase 1 lands). That single PR turns the audit gate from persistently red back to green and unblocks PR #464.

## Audit Results

### JS workspace — `bun audit` (19 distinct advisories, gate threshold = moderate)

| Severity | Count | Direct | Transitive |
|---|---|---|---|
| Critical | 0 | 0 | 0 |
| High | 6 | 0 | 6 |
| Moderate | 10 | 1 | 9 |
| Low | 3 | 1 | 2 |

11 of the 16 moderate+high advisories are **not yet on the `scripts/audit.ts` ignore list**, which is why `bun run audit` currently exits 1 (reproduced locally, byte-for-byte matches CI). The other 5 are on the list and still valid matches (not stale) — but all 5 also clear via the same fix.

### Critical / High findings

| Package | Current (locked) | Vulnerable Range | Fixed In | GHSA | Direct? | On ignore list? |
|---|---|---|---|---|---|---|
| `ip-address` | 10.2.0 | `<=10.3.0` | 10.3.1 (latest 10.7.0) | GHSA-mwp4-54f8-5fhr (+2 moderate: GHSA-4xrf-jv44-h6hh, GHSA-22jq-vg5j-6vgg) | no — via `@anthropic-ai/claude-agent-sdk` → `@modelcontextprotocol/sdk` → `express-rate-limit@^10.2.0` | no |
| `brace-expansion` | 5.0.8 / 2.1.2 / 1.1.16 (3 locked instances) | `>=4.0.0 <5.0.9` / `<2.1.4` / `<1.1.18` | 5.0.9 / 2.1.4 / 1.1.18 | GHSA-rgw5-rvv9-x895 (bypasses the mitigation the ignored GHSA-mh99-v99m-4gvg was about) | no — via `minimatch` (3 separate chains: typescript-eslint, eslint-plugin-jsx-a11y, glob) | GHSA-mh99 is ignored (now stale-fixable), GHSA-rgw5 is not |
| `nanoid` | 3.3.16 | `<3.3.18` | 3.3.18 | GHSA-2v37-7h3g-55p8 | no — via `postcss@^3.3.16`, `vite`, `@astrojs/starlight` | no |
| `fast-uri` | 3.1.4 (from root `overrides`) | `>=3.0.0 <3.1.5` | 3.1.5 | GHSA-7p8r-x3mc-p8w7 | no — via `ajv@8.20.0` (`^3.0.1`), consumed by `@typescript-eslint/rule-tester`, `eslint`, and the MCP transport inside `@anthropic-ai/claude-agent-sdk` | no — **the current override (`>=3.1.4 <4`) is itself one patch short of the fix** |
| `js-yaml` | (from root `overrides`) | `>=4.0.0 <4.3.1` | 4.3.1 | GHSA-5p4m-2wfm-xmqj | no — via `@astrojs/starlight`/`astro` (docs workspace) | no — **the current override (`>=4.3.0 <5`) is one patch short of the fix**, same pattern as fast-uri |

### Notable moderate finding (direct dependency)

`dompurify` (apps/web, direct, `^3.2.4` in `package.json`, locked at 3.4.11) — GHSA-55q2-fjhq-7xh7 (moderate, "IN_PLACE hook removal leaves a detached subtree executable, causing XSS") affects `<=3.4.12`; also GHSA-c2j3-45gr-mqc4 (low) affects `<=3.4.11`. This is exactly the class of advisory `scripts/audit.ts`'s own docstring calls out as the reason the gate exists ("Nightcore renders model/PR/web content through marked + dompurify + shiki"). Fix is 3.4.13+ (latest 3.4.14), already inside the declared `^3.2.4` range — no `package.json` edit needed, just a lockfile refresh.

### `hono` / `@hono/node-server` (all transitive, via `@anthropic-ai/claude-agent-sdk` → `@modelcontextprotocol/sdk`)

Locked `hono@4.12.26`. 6 distinct moderate GHSAs total: 3 already ignored (GHSA-xgm2-5f3f-mvvc, GHSA-hvrm-45r6-mjfj, GHSA-w62v-xxxg-mg59, all fixed at `>=4.12.27`) and 3 new (GHSA-8j4g-w8fx-2239, GHSA-f23p-vx2j-j53r, GHSA-54fx-42gc-7vw4, fixed at `>=4.12.34`), plus one low (GHSA-79qm-7rj5-m7r9). `@modelcontextprotocol/sdk` declares `hono: "^4.11.4"` — latest 4.13.5 is already inside that range. `@hono/node-server@1.19.14` (ignored GHSA-frvp-7c67-39w9, fixed at `>=1.19.15`) is pulled in via `@modelcontextprotocol/sdk`'s own `^1.19.9`; latest 1.x is 1.19.17, also inside range. **All 6 hono findings + the node-server one clear via the same `bun update` — no override, no manifest edit.**

### Rust crate — `cargo audit` (`apps/desktop/src-tauri/`, 546 crates scanned)

**Zero actual vulnerabilities.** 19 "allowed warnings" (unmaintained/unsound advisories, which `cargo-audit` treats as non-fatal by default and `.cargo/audit.toml` doesn't need to suppress): the gtk-rs GTK3 binding family (`atk`, `gdk`, `gtk`, etc. at 0.18.x — "no longer maintained", pulled in transitively via `tray-icon`/`muda` for Linux tray-icon support only), `proc-macro-error` (unmaintained), the `unic-*` Unicode crates (unmaintained), `anyhow` 1.0.102 (unsound `downcast_mut`, fixed upstream — picked up automatically by `cargo update`), `event-listener` 5.4.1 (unsound, fix exists), and `glib` 0.18.5 (unsound `VariantStrIter`, RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g — this is the **one Dependabot alert** below).

`.cargo/audit.toml` ignores 2 advisories: `RUSTSEC-2026-0194` and `RUSTSEC-2026-0195` (`quick-xml` <0.41 DoS, pulled in via `plist`→tauri Info.plist parsing and `tauri-winrt-notification`→Windows toast XML). The comment says "no tauri/plist/notify-rust release with quick-xml >=0.41 exists yet" — **that is no longer true.** `cargo update --dry-run` (lockfile-only, zero `Cargo.toml` edits) now collapses both locked `quick-xml` instances (0.37.5, 0.39.4) into a single `quick-xml 0.41.0`, clearing both ignore entries.

## Dependabot Alerts

`gh` is authed (Shironex), repo is `noctcore/nightcore` on GitHub. **1 open alert, Rust ecosystem only:**

| GHSA | Package | Severity | Fixed In |
|---|---|---|---|
| GHSA-wrw7-89jp-8q8g | `glib` (Rust) | medium | 0.20.0 |

Cross-reference note: the npm ecosystem shows **zero** open Dependabot alerts despite `bun audit` finding 11 unignored moderate/high advisories in the JS tree. Dependabot's advisory-database sync for this repo is either behind `bun audit`'s own DB or the npm-ecosystem alert feature isn't fully populated here — **treat `bun run audit` as the source of truth for JS advisories, not the GitHub Security tab, until this is reconciled.** The glib alert matches `cargo audit`'s RUSTSEC-2024-0429 finding exactly — fixing it requires the gtk-rs stack to move 0.18→0.20+, gated on `tray-icon`/`muda` shipping a release built against it (external blocker, Linux-tray-icon-only code path; `.github/workflows/*.yml` build/release jobs target macOS/Windows only — no Linux desktop build target found — so this is low urgency today).

## Safe Bumps — Phase 1 (single PR, kirei-stitch)

**Mechanism, not a package list**: run `bun update` at the repo root (updates the whole workspace within already-declared semver ranges — no `package.json` edits needed for anything below except the two overrides and the zod pin) + two override edits + one Rust `cargo update`. This single operation resolves every CVE finding above.

| Change | Current → Target | Type | Resolves CVE? | Notes |
|---|---|---|---|---|
| `bun update` (whole JS workspace) | see individual packages below | patch/minor | yes — clears 11 new + 5 ignored | one lockfile-only op |
| ↳ `dompurify` (apps/web, direct) | 3.4.11 → 3.4.14 | minor (within `^3.2.4`) | yes (GHSA-55q2, GHSA-c2j3) | direct dep, sanitizer — see Phase 2 for the extra check |
| ↳ `ip-address` (transitive) | 10.2.0 → 10.7.0 | patch-line (within `^10.2.0`) | yes (GHSA-mwp4 + 2 moderate) | pulled by `express-rate-limit` via MCP SDK |
| ↳ `brace-expansion` ×3 chains | 5.0.8→5.0.9, 2.1.2→2.1.4, 1.1.16→1.1.18 | patch (within each chain's declared range) | yes (GHSA-rgw5 + stale GHSA-mh99) | no override needed — do NOT reintroduce the reverted override (#411) |
| ↳ `nanoid` (transitive) | 3.3.16 → 3.3.18 | patch (within `^3.3.16`) | yes (GHSA-2v37) | via postcss/vite/astro |
| ↳ `hono` (transitive) | 4.12.26 → 4.13.5 | minor (within `^4.11.4`) | yes (6 GHSAs, 3 new + 3 already-ignored) | via MCP SDK |
| ↳ `@hono/node-server` (transitive) | 1.19.14 → 1.19.17 | patch (within `^1.19.9`) | yes (GHSA-frvp, already-ignored) | via MCP SDK |
| `fast-uri` override | `>=3.1.4 <4` → `>=3.1.5 <4` | override lower-bound bump | yes (GHSA-7p8r) | one-line edit, `assertOverridesBounded()` still satisfied |
| `js-yaml` override | `>=4.3.0 <5` → `>=4.3.1 <5` | override lower-bound bump | yes (GHSA-5p4m) | one-line edit, same pattern |
| `scripts/audit.ts` — delete `IGNORED` entries | remove all 5 | cleanup | n/a | **required**, not optional — the script hard-fails if any entry no longer matches a live advisory once Phase 1 lands |
| `zod` (root + `packages/config`, `packages/contracts`, `packages/engine`) | `4.4.3` → `4.5.4` | minor, exact pin | no | pin is deliberate (codegen-hoisting reliability per commit 27755f8a), not CVE-driven; bump all 4 files together to keep them identical |
| `cargo update` (`apps/desktop/src-tauri/`) | ~140 crates, patch/minor | patch/minor | yes — clears `quick-xml` DoS ×2 | zero `Cargo.toml` edits; Tauri core itself already at latest 2.11.5 |
| ↳ includes `tauri-plugin-dialog` 2.7.2→2.7.3, `tauri-plugin-fs` 2.5.1→2.5.2, `tauri-plugin-notification` 2.3.3→2.4.0, `tauri-plugin-single-instance` 2.4.3→2.4.4, `tauri-plugin-updater` 2.10.1→2.11.0 | | | | mirrors the JS-side `@tauri-apps/plugin-*` bumps below — bump both sides together to keep plugin/binding version parity |
| `.cargo/audit.toml` — delete `RUSTSEC-2026-0194`/`0195` ignore entries | remove both | cleanup | n/a | recommended once `quick-xml` resolves to 0.41.0; `cargo-audit`'s ignore list doesn't self-enforce staleness the way `scripts/audit.ts` does, but a stale entry is dead weight and hides a future real quick-xml advisory |
| Other patch-level bumps swept up by the same `bun update` | see table below | patch | no | pure drift cleanup |

**Also swept up by the same `bun update` (no CVEs, pure patch drift, zero behavioral risk):**

| Package | Workspace | Current → Update |
|---|---|---|
| `@tanstack/react-virtual` | web | 3.14.4 → 3.14.10 |
| `@tauri-apps/plugin-dialog` | web | 2.7.1 → 2.7.3 |
| `@tauri-apps/cli` (dev) | desktop | 2.11.3 → 2.11.4 |
| `react` / `react-dom` | web | 19.2.7 → 19.2.8 |
| `@types/react` / `@types/react-dom` (dev) | web | 19.2.17→19.2.18 / 19.2.3→19.2.5 |
| `@tailwindcss/vite` / `tailwindcss` (dev) | web | 4.3.1 → 4.3.3 |
| `playwright` (dev) | web | 1.61.0 → 1.62.1 |
| `eslint` (dev) | root | 10.8.0 → 10.9.1 |
| `@eslint/js` (dev) | root | 9.39.4 → 9.39.5 |
| `@types/bun` (dev) | root, harness | 1.3.14 → 1.4.0 |
| `@types/node` (dev) | root, eslint-plugin, harness | 22.20.0 → 22.20.1 |
| `@astrojs/starlight` / `astro` | docs | 0.41.5→0.41.10 / 7.1.6→7.2.9 |

## Low-Risk Minors Needing a Smoke Check — Phase 2

Same-major, semver-compatible bumps, but with a plausible behavioral surface — verify beyond typecheck/lint/test before merging (or bundle into a slightly larger, still-single PR with the specific check called out).

| Package | Current → Target | Type | Why it needs a look |
|---|---|---|---|
| `dompurify` | 3.4.11 → 3.4.14 | minor | It's the XSS sanitizer for model/PR/web content — re-run whatever web workspace test exercises marked+dompurify+shiki rendering after the bump, not just typecheck |
| `@tauri-apps/plugin-updater` (JS) + `tauri-plugin-updater` (Rust) | 2.10.1→2.11.0 / 2.10.1→2.11.0 | minor | This is the signed auto-updater — smoke-test an actual update-check flow, not just build green (release infra is intentionally sensitive per the v0.1.0 updater work) |
| `shiki` | 4.3.0 → 4.4.3 | minor | Repo uses a fine-grained (non-wasm) Shiki bundling setup — verify syntax highlighting still renders in the terminal/diff views after the bump |
| `lucide-react` | 1.21.0 → 1.38.0 | minor (same 1.x major, 17 releases of drift) | Icon set — large jump in release count; spot-check a few icons used in the app still render (renamed/removed icons are the usual breakage in this library even within 1.x) |
| `@typescript-eslint/utils` / `parser` / `rule-tester` | 8.61.1 → 8.68.0 | minor | Feeds `lint-meta` and the eslint-plugin's `RuleTester`-based tests — run `bun run lint`, `bun run lint:meta`, and `bun run test:plugin` explicitly, not just trust the version range |
| `motion` | 12.42.2 → 12.43.0 | minor | Animation library, low usage risk but worth a visual pass on any animated surfaces |
| `astro` / `@astrojs/starlight` | 7.1.6→7.2.9 / 0.41.5→0.41.10 | minor | Docs-site only, low blast radius, but run `bun run --filter @nightcore/docs build` once since it's a content pipeline, not just types |

## Risky Bumps — Need Migration (Phase 3, one `/kirei migrate <pkg>` each)

| Package | Current | Target | Why risky | Reason to bump |
|---|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | 0.3.190 | 0.3.251 (61 releases behind) | Pre-1.0 semver — the repo's own `dependabot.yml` explicitly excludes this package from ALL automated bumps (patch/minor/major) because "0.3.x → 0.3.y can carry breaking changes" and it's the load-bearing engine provider; last deliberate move was PR #412-adjacent territory. Needs its own reviewed migration, not a mechanical bump. |
| `@openai/codex-sdk` | 0.145.0 | 0.151.0 | Same 0.x-semver reasoning as claude-agent-sdk; secondary provider integration (per `project_codex_integration_296` / `project_codex_model_issues`), version churn here has broken model-list/auth before |
| `typescript` | 5.9.3 | 7.0.2 (skips a whole major, 6→7) | Gates `tsc -b` across the entire monorepo; Dependabot PR #418 has been open since 2026-07-25 untouched — this is the biggest single blast-radius bump in the tree |
| `vitest` + `@vitest/browser` + `@vitest/coverage-istanbul` + `vitest-browser-react` | 3.2.7 / 3.2.7 / 3.2.7 / 1.0.1 | 4.1.11 / 4.1.11 / 4.1.11 / 2.2.0 | Must move as one unit; repo has a documented CI trap where a mid-run Vite dep-optimize can orphan a vitest browser file and silently hang CI (`reference_web_coverage_ci_freeze`) — a major here is exactly where that class of regression would resurface. Dependabot PRs #457/#456/#453 are open and stalled — treat as one migration covering all three packages together, not three separate merges. |
| `vite` (+ `@vitejs/plugin-react`) | 7.3.6 / 5.2.0 | 8.2.2 / 6.1.1 | Build tool major; couples with the Vitest 4 migration above since both share the Vite dep graph — sequence after or alongside Vitest 4, not independently |
| `storybook` (+ `@storybook/addon-a11y`, `addon-vitest`, `react-vite`) | 9.1.20 (×4) | 10.5.10 (×4) | Already attempted and abandoned once: Dependabot PRs #413/#414 (Storybook 9→10) were opened 2026-07-25 and closed unmerged. Whatever blocked that attempt needs to be understood before retrying. |
| `marked` | 15.0.12 | 18.0.11 (3 majors) | Markdown renderer paired with the `dompurify` sanitizer for untrusted content — a 3-major jump plausibly changes escaping/renderer defaults; Dependabot PR #454 (15→18.0.7) has been open since 2026-08-01 untouched. Security-adjacent, review the changelog for sanitization-relevant changes specifically, not just API breaks. |
| `motion` | 12.43.0 (post-Phase-1) | 13.1.1 | Animation library major; low usage risk but untriaged |
| `glib` (Rust, transitive via `tray-icon`/`muda`) | 0.18.5 | 0.20.0+ | Clears the one open Dependabot alert (GHSA-wrw7-89jp-8q8g) and the whole "unmaintained GTK3 bindings" warning cluster, but is blocked on `tray-icon`/`muda` shipping a release against gtk-rs 0.19/0.20 — an upstream wait, not something this repo can force. Linux tray-icon code path only; no Linux desktop build target found in CI/release workflows today, so low urgency. Track, re-check `cargo update --dry-run` after each `tray-icon`/`muda`/tauri bump. |

## Strategic Backlog — Phase 4 (no immediate pressure)

- `@eslint/js` is still pinned `^9.0.0` in root `devDependencies` even though `eslint` itself is already on the v10 line (migrated in the grouped PR referenced by `dependabot.yml`'s own comment about PR #396). This looks like a leftover from that migration — align it to `^10.0.0` (10.0.1 exists) when convenient; low risk, not urgent.
- `eslint-plugin-simple-import-sort` 13.0.0 → 14.0.0 (major, import-ordering only, tiny blast radius).
- `@types/node` 22.20.1 → 26.4.0 (major): do **not** bump ahead of the runtime target — `package.json` `engines.node` requires `>=22`; moving `@types/node` to the v26 line would type-check against Node APIs the runtime doesn't guarantee. Revisit only alongside an actual Node engine bump.
- `motion` 12.x → 13.x, `marked` 15.x → 18.x, `storybook` 9.x → 10.x are all also technically "strategic" if none of their CVE/drift signals are urgent on their own — listed under Phase 3 above because each already has real activity (open/closed Dependabot PRs) worth acting on rather than deferring indefinitely.

## Verification

- After Phase 1: re-run `bun run audit` — expect 0 failures (all 16 moderate+high advisories clear, `IGNORED` array in `scripts/audit.ts` empty and passing its own no-stale-entries check). Re-run `cargo audit` from `apps/desktop/src-tauri` — expect the same 19 warnings minus nothing new (warnings aren't gated) but `quick-xml` should no longer appear at all, letting the two `.cargo/audit.toml` entries be deleted with a clean conscience.
- Typecheck (`tsc -b` / `bun run typecheck`), `bun run lint` (includes `lint:meta`), `bun run test:node`, `bun run test:web`, `bun run test:plugin`, and `bun run test:rust` must all stay green at Phase 1 and Phase 2 — this is a lockfile-only + two-file-edit change set, so a red gate here means the "safe" classification was wrong somewhere and needs re-checking before merge.
- For `dompurify` and `shiki` specifically (Phase 2): manually exercise whatever screen renders model/PR markdown with syntax-highlighted code blocks — these are the two packages in the sanitizer/highlighter path the audit gate's own docstring calls out as the reason the gate is at `moderate` threshold in the first place.
- For `@tauri-apps/plugin-updater` / `tauri-plugin-updater` (Phase 2): run an actual update-check against the signed-updater flow (per `project_release_updater_plan` memory, this component has real signing/key-rotation stakes) — build+test green is not sufficient evidence here.
- Confirm PR #464 (open, mergeable, cargo-audit already green) merges cleanly once the bun-audit job goes green from Phase 1 — it's currently blocked purely by the unrelated JS check.
- Re-check Dependabot PRs #457/#456/#453 (Vitest 4), #454 (marked), #418 (typescript) — none of these are stale/abandoned by the bot, they're just waiting on the manual majors review this report recommends (Phase 3).

## Tool Gaps Noted

- No `pip-audit`/`safety`/`govulncheck`/`bundle audit` relevant — this repo has no Python/Go/Ruby dependency surface.
- `cargo-outdated` is not installed; used `cargo update --dry-run` (lockfile-refresh simulation within declared `Cargo.toml` ranges) instead, which is sufficient for this repo since it answers "what does a safe `cargo update` change" directly, but does not show crates whose fix requires a `Cargo.toml` major-version edit beyond the declared range (none were found needing that here besides `glib`, which is already covered above).
- `gh api .../dependabot/alerts?state=all` via `--paginate` returned inconsistent results depending on how the query param was passed (embedded in the URL worked; `-f state=all` 404'd) — resolved by using the default (state=open) call, which is complete for this report's purposes (1 open alert, cross-checked against `cargo audit`'s own findings).

## Out of Scope

- Dev-only / build-tool-only advisories at `low` severity (`esbuild` GHSA-g7r4, `dompurify` GHSA-c2j3, `hono` GHSA-79qm) are below the repo's own `moderate` gate threshold — noted in the full audit table above but not broken out as their own action items; they'll clear incidentally as part of Phase 1's `bun update` anyway.
- Private/internal `@nightcore/*` and `@noctcore/*` workspace/npm packages are first-party and out of scope for a dependency-vulnerability audit (no external advisory surface); `@noctcore/eslint-plugin-*` version pins (`^0.2.0`) were checked for outdated status only, not audited for CVEs.
