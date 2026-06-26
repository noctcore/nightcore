# Debug Report: Harness-run logs are double-stamped (two timestamps + two levels per line)

**Date:** 2026-06-26
**Agent:** kirei-debug
**Status:** root cause confirmed (static analysis + existing rolling logs; no instrumentation needed)

## Symptom
Every harness/sidecar log line carries TWO formatted log records concatenated on one line — two ISO timestamps, two levels, and two origin prefixes. Captured verbatim while running a harness run under `tauri dev`:

```
2026-06-26T19:51:58.183157Z  INFO sidecar: 2026-06-26T19:51:58.183Z INFO [sidecar:harness] [harness:design-decisions] turn 7 · Glob
```

Decomposed:
- OUTER (Rust `tracing` fmt layer): `2026-06-26T19:51:58.183157Z  INFO sidecar: `
  - `…183157Z` = tracing's RFC3339 timer (6-digit subsecond), `INFO` = tracing level, `sidecar:` = the event `target`
- INNER (Bun sidecar shared logger): `2026-06-26T19:51:58.183Z INFO [sidecar:harness] `
  - `…183Z` = `new Date().toISOString()`, `INFO` = uppercased level, `[sidecar:harness]` = logger scope
- The actual message: `[harness:design-decisions] turn 7 · Glob`

Confirmed in the rolling log file `~/Library/Logs/dev.shirone.nightcore/nightcore.log.2026-06-26` (lines 85–122+): every line that flows through the sidecar's shared logger is double-stamped.

## Expected
One timestamp, one level, one origin tag per line, e.g.:

```
2026-06-26T19:51:58.183157Z  INFO sidecar: [harness:design-decisions] turn 7 · Glob
```

(Rust `tracing` owns timestamp + level + target; the message body is the sidecar's text only.)

## Repro
**Command / scenario:**
```
Run any harness (or insight) run under `tauri dev`, then inspect either the
dev console or the rolling file:
  ~/Library/Logs/dev.shirone.nightcore/nightcore.log.2026-06-26
Filter for sidecar lines emitted via the shared logger (lens lifecycle + the
per-3s heartbeat), e.g.:
  grep 'INFO sidecar: 2026-' nightcore.log.2026-06-26
```
**Reliability:** Always — unconditional for every line the sidecar emits through `@nightcore/shared` `createLogger`. It is NOT harness-specific (see "Scope" below); harness lines just dominate because the heartbeat fires every 3 s per concurrent lens.

## Root Cause
A two-layer formatting collision: the sidecar self-formats each line (timestamp + level + scope) AND the Rust core re-wraps that already-formatted line through `tracing` (which adds its own timestamp + level + target). Neither layer knows the other is also formatting.

**INNER half — sidecar self-formats (Bun / TypeScript):**
- **Location:** `packages/shared/src/logger.ts:42-51` (`format()`), timestamp built at `:43` (`const ts = new Date().toISOString();`), assembled at `:50` (`` return `${ts} ${level_} [${scope}] ${msg}${tail}`; ``), written to **stderr** at `:66` (`process.stderr.write(...)`).
- The visible inner message in the example is the harness heartbeat: emitted at `packages/engine/src/analysis-manager.ts:485-487` (`` logger.info(`${label} turn ${turn} · …`) ``); `label` = `[harness:design-decisions]` from `packages/engine/src/harness-manager.ts:411` (`` `[harness:${preset.category}]` ``); the logger's `[sidecar:harness]` scope comes from `packages/engine/src/session-manager.ts:128` (`logger.child('harness')`) layered on the root `createLogger(config.logLevel, 'sidecar')` at `apps/sidecar/src/index.ts:180`.

**OUTER half — Rust re-wraps (Rust / tracing):**
- **Location:** `apps/desktop/src-tauri/src/sidecar/mod.rs:166-173` (`emit_sidecar_line`), specifically `:170` (`tracing::info!(target: "sidecar", "{line}")`). The captured stderr line — already fully formatted by the sidecar — is passed as the *entire message* to a tracing macro.
- The stderr drain loop that feeds it: `apps/desktop/src-tauri/src/sidecar/mod.rs:139-147`.
- The fmt layer that prepends the OUTER timestamp + level + `target`: `apps/desktop/src-tauri/src/infra/logging.rs:45-49` (`fmt::layer()...with_target(true)` for both console and rolling file; default RFC3339 timer).

**Mechanism (one sentence):** The sidecar's shared logger prepends `<ISO> <LEVEL> [scope]` to every line and writes it to stderr; the Rust core drains that stderr and re-emits each line *verbatim as a tracing message* under `target: "sidecar"`, so the tracing fmt layer prepends a *second* `<ISO> <LEVEL> sidecar:`.

**Introduced by:** Predates current visible history as a latent collision; it became *universal* when the sidecar's stderr was piped into tracing ("M4.5 §B4", per the comment at `mod.rs:136-138`). The harness heartbeat that makes it so visible was added recently (commit `9999393 feat(engine): stream scan progress to logs, parallelize lenses` / `3410d05 feat(core): log per-category scan progress to tracing`).

## Scope: is it ALL sidecar lines, or only harness?
**All lines emitted through the shared `createLogger` — not harness-specific.** The rolling log proves the split:
- Double-stamped: every `logger.info/warn/...` line (harness lens lifecycle, the heartbeat, insight, session-manager, etc.) — these pass through `format()` (`logger.ts:42`).
- Single-stamped: lines that bypass the shared logger's `format()`:
  - `nightcore-sidecar ready` — written raw via `process.stderr.write('nightcore-sidecar ready\n')` at `apps/sidecar/src/index.ts:192` (no inner timestamp → Rust wraps it once).
  - `sidecar process spawned` / `sidecar spawned (bun)` — Rust's own `tracing::info!(target:"sidecar", …)` (`apps/desktop/src-tauri/src/m2/provider.rs:333-339`, `apps/desktop/src-tauri/src/sidecar/mod.rs:102`).

There is **no** raw/JSON-vs-pretty toggle and **no** env flag (NODE_ENV / LOG_FORMAT) that disables the self-format. `useColor()` (`logger.ts:38-40`) only gates ANSI *color of the LEVEL token* on `process.stderr.isTTY`; under `tauri dev` stderr is piped (not a TTY) so color is off, but the timestamp + level + scope prefix is **still emitted**. So the double-stamp is unconditional whenever Rust drains the sidecar (which is always).

## Evidence
- `packages/shared/src/logger.ts:50` builds `` `${ts} ${level_} [${scope}] ${msg}${tail}` `` and writes it to stderr at `:66`. This is the INNER `2026-06-26T19:51:58.183Z INFO [sidecar:harness] …`.
- `apps/desktop/src-tauri/src/sidecar/mod.rs:170` re-emits the whole captured line as a tracing message; `apps/desktop/src-tauri/src/infra/logging.rs:45` adds the OUTER `<iso> INFO sidecar: `.
- **Natural reverse-test already present in the data (no instrumentation needed):** the single-stamped `nightcore-sidecar ready` line (raw `process.stderr.write`, `apps/sidecar/src/index.ts:192`) proves that a sidecar stderr line *without* the self-format comes out with exactly ONE timestamp. i.e., removing the sidecar's self-prepended `<ISO> <LEVEL> [scope]` yields the single-stamp expected output. This isolates the INNER `format()` as the duplicated half and confirms Rust's single wrap is correct on its own.
- Rolling-log lines 3/4/6 (single-stamped Rust/raw) vs 85–122 (double-stamped shared-logger) in `~/Library/Logs/dev.shirone.nightcore/nightcore.log.2026-06-26`.

## Which layer should own formatting?
**Rust `tracing` should own timestamp + level + target.** Rationale: tracing is the process-wide canonical sink (colored console + daily rolling file, `RUST_LOG`/`EnvFilter` level control, structured `target`/fields) — `infra/logging.rs`. The sidecar's stderr is *explicitly drained into* that sink (the `mod.rs:136-138` comment states the intent: "re-emit each leveled line through the Rust tracing sink under target `sidecar` so it lands in the same colored console + rolling file"). Therefore the sidecar should emit **message text only** (no self-prepended ISO timestamp, no duplicate level word, no `[sidecar:…]` scope that just restates the `target`) when its output is being captured, and let Rust stamp it once.

**Coupling caveat (must not be missed):** Rust currently recovers the level by reading the **second** whitespace field — `sidecar_level()` at `apps/desktop/src-tauri/src/sidecar/mod.rs:186-194`, `:187` uses `.split_whitespace().nth(1)` precisely because today field 0 is the sidecar's ISO timestamp and field 1 is the level token. If the sidecar drops its leading timestamp, the level token moves to field 0 and this parse must move in lockstep (`.nth(0)`), or every captured line silently degrades to `Info`. The two sides share an implicit wire contract and **must change together.**

## Recommended Fix
**Approach (preferred — Option A): Rust owns the stamp; sidecar emits a minimal, parseable form when captured.** Make the sidecar logger, when stderr is **not a TTY** (i.e. captured by Rust), emit `LEVEL message` (drop the self-timestamp and the redundant `[scope]`/keep scope only inside the message if desired), and have Rust parse + strip the leading LEVEL token before re-emitting only the message through `tracing`.

**Files to change (coordinated, both halves required):**
- `packages/shared/src/logger.ts:42-51` (`format()`) — when `!useColor()`/piped, do **not** prepend `${ts}` (and drop the duplicate `[${scope}]` — the Rust `target: "sidecar"` already conveys origin; fold the harness sub-label into the message as it already is). Keep the uppercase LEVEL token **first** so Rust can recover the level. (TTY/interactive standalone CLI use — e.g. `apps/cli` — may keep the full pretty self-format; gate on `useColor()`/TTY.)
- `apps/desktop/src-tauri/src/sidecar/mod.rs:166-194` (`emit_sidecar_line` + `sidecar_level`) — parse the leading LEVEL token as field **0** (update `sidecar_level`'s `.nth(1)` → `.nth(0)` at `:187`), strip it from the line, and re-emit only the remaining message via `tracing::{error,warn,info,debug}!(target:"sidecar", "{rest}")` at `:168-171`. This leaves Rust as the sole owner of timestamp + level + target.

**Rejected alternative (Option B): Rust passes sidecar lines through verbatim** (write the sidecar's already-formatted line straight to the sink instead of through a tracing macro). Rejected: it bypasses tracing's `EnvFilter` level control + structured pipeline and splits formatting ownership across two code paths — messier and against the stated `mod.rs:136-138` design intent.

## Regression Test to Promote
Lock the sidecar half: in non-TTY (captured) mode the formatted line must NOT begin with its own ISO-8601 timestamp (the duplicated stamp), and must still start with a parseable LEVEL token.

- **Test file:** `packages/shared/src/logger.test.ts`
- **Test body:**
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createLogger } from './logger.js';

describe('logger format under capture (non-TTY)', () => {
  const originalIsTTY = process.stderr.isTTY;
  const originalWrite = process.stderr.write.bind(process.stderr);
  afterEach(() => {
    (process.stderr as { isTTY?: boolean }).isTTY = originalIsTTY;
    process.stderr.write = originalWrite;
  });

  it('does NOT self-prepend an ISO timestamp when stderr is piped (Rust owns the stamp)', () => {
    (process.stderr as { isTTY?: boolean }).isTTY = false; // captured by Rust core
    let line = '';
    // @ts-expect-error narrow stub for the test
    process.stderr.write = (chunk: string) => ((line = chunk), true);

    createLogger('info', 'sidecar').child('harness').info('[harness:design-decisions] turn 7 · Glob');

    // The duplicated half is the leading ISO-8601 timestamp. Post-fix it must be gone.
    expect(line).not.toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Level token must remain FIRST so the Rust side (sidecar_level) can parse it as field 0.
    expect(line.trimStart()).toMatch(/^INFO\b/);
    // The message body survives intact.
    expect(line).toContain('[harness:design-decisions] turn 7 · Glob');
  });
});
```
Companion Rust assertion (add to the `#[cfg(test)] mod tests` near `apps/desktop/src-tauri/src/sidecar/mod.rs`): given an input line `"INFO [harness:design-decisions] turn 7 · Glob"`, `sidecar_level` returns `Info` and the re-emitted message contains no second ISO timestamp (assert via the stripped `rest`).

## Instrumentation to Remove
None — diagnosed entirely from static analysis of the two logging layers plus the existing rolling log files in `~/Library/Logs/dev.shirone.nightcore/`. No temporary instrumentation was added; no production code was modified.

## Risks
- **Coupled wire contract:** the sidecar's emitted level-token position and Rust's `sidecar_level` parse (`mod.rs:187`) MUST change together. Changing one side alone either re-introduces a stray token in the message or collapses all levels to `Info`.
- **CLI/standalone use:** `apps/cli` (`apps/cli/src/index.ts`) also uses `createLogger`; when run interactively (TTY) it should keep human-friendly self-formatting. Gate the format change on `useColor()`/`isTTY` so only the captured (piped) path drops the self-stamp.
- **Non-logger stderr lines:** raw lines like `nightcore-sidecar ready` (`apps/sidecar/src/index.ts:192`) and any SDK/runtime stderr have no LEVEL token; `sidecar_level` must keep defaulting unknown field-0 tokens to `Info` (it already does) so these still pass through as single-stamped Info.
- **Color codes:** if any future path emits ANSI on a TTY into the captured stream, the level token could be wrapped in SGR codes; current `useColor()` correctly disables color when piped, so this is not a regression risk for the fix as scoped.

## How to Verify the Fix
1. Apply the coordinated fix (both `logger.ts` and `sidecar/mod.rs`).
2. Remove instrumentation — none to remove.
3. Run the promoted regression test(s): `bun run --filter @nightcore/shared test` (TS) and `cargo test` in `apps/desktop/src-tauri` (Rust `sidecar_level`).
4. Re-run a harness run under `tauri dev` and inspect `~/Library/Logs/dev.shirone.nightcore/nightcore.log.<today>`: each sidecar line must show exactly ONE timestamp + ONE level, e.g. `… INFO sidecar: [harness:design-decisions] turn N · Glob` — the inner `<ISO> INFO [sidecar:harness]` must be gone.
