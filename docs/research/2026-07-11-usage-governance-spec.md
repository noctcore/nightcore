# Build spec: usage-aware auto-mode throttling (pause the loop when a rate-limit window is hot)

**Date:** 2026-07-11
**Status:** build-ready. Every decision in § 1 is locked (user-grilled 2026-07-11). Do NOT
re-litigate; implement.
**Extends (read first — this feature CONSUMES both, it does not rebuild them):**
`docs/research/2026-07-11-usage-meter-spec.md` — the shipped provider usage meter (`usage/`
Rust poller, `UsageRegistry` managed state, `nc:usage` channel, `RateWindow`/`ProviderUsage`/
`UsageMeter` contracts). This spec adds the FIRST consumer of `RateWindow.used_percent` that
gates behavior; the meter itself is unchanged.
`docs/research/2026-07-10-*` auto-loop lineage — the coordinator's `tick`/breaker machinery this
gate extends.

> An implementer with no session context can build this from § 3. It is **ONE PR** (§ 9): a Rust
> gate in the coordinator tick + one serde-additive Settings field + the web gear-popover slider,
> board banner, and manual-start chip. The gate lives in **Rust**, not a web observer — see the
> loud flag in § 10.1, which corrects the "web observer like `useAutoCommit`" premise against the
> shipped code.

---

## 1. Decision record (grilled 2026-07-11 — recorded verbatim, do not reopen)

| # | Decision | Outcome |
|---|---|---|
| 1 | **Scope** | When hot, **Auto Mode stops picking up NEW runs**; **already-running sessions finish naturally**; **MANUAL run starts stay allowed** but show a **warning chip**. |
| 2 | **Threshold** | Default **90%**; a user slider **50–100%** living in the **Auto Mode gear popover** (next to the existing auto-commit option). **ANY window** crossing it (**5h OR weekly OR model-scoped**) triggers the pause, **for the provider the runs use** (v1: **Claude**). |
| 3 | **Resume / UX** | **Auto-resume** when a subsequent poll shows **all windows back under threshold**. A **dismissable board banner** while paused (*"Auto mode paused — Claude 5h window at N%, resumes ~HH:MM"* using `resets_at`). **ONE native OS notification** when the pause **first triggers**. **NO tray icon** in this run. |
| 4 | **Fail-open** | The gate is active **ONLY** when the usage meter is **enabled** (it is opt-in) **AND** the snapshot is **fresh**. Meter off / stale / not-connected / error ⇒ **never block** (undocumented endpoint — it must not halt automation). |

**Hard constraints (carried from the decisions, do not violate):**

- **The gate is a pre-launch check, never a mid-run kill.** It gates *which* new runs the auto-loop
  starts. It must NEVER interrupt an in-flight session (that is the difference between the loop's
  breaker *pause* and its *stop* — § 3.1). "Running sessions finish naturally" is non-negotiable.
- **Manual starts are never blocked.** The chip is *advisory* — the manual `run_task` path must
  stay fully functional while auto mode is usage-paused. The gate must therefore live where ONLY
  the auto-loop passes, not in the shared `submit_run` chokepoint (§ 3.4).
- **Fail-open is the default posture.** The usage endpoints are reverse-engineered and unversioned.
  Any doubt — meter disabled, snapshot stale/absent, provider row not `Ok` — resolves to **do not
  gate**. An automation halt caused by a flaky telemetry read is a worse failure than an
  over-run window.
- **No new event channel, no new tray surface.** The pause rides the existing `nc:loop` state
  (a new `reason` value), and the banner reads window specifics from the `nc:usage` snapshot the
  web already holds. No `nc:*` channel is added.

---

## 2. What this is (and is NOT)

A **governor** that pauses the autonomous loop's *task pickup* when the provider the runs use is
near a rate-limit ceiling, and auto-resumes when it cools. It is:

- a **pre-launch gate** on the coordinator tick (§ 3.1), evaluated live each tick from the shipped
  `UsageRegistry` snapshot;
- **opt-in by construction** — inert unless the user has enabled the usage meter (decision 4);
- **self-clearing** — it does not latch; when the next 10-min poll shows the window under
  threshold, the next tick resumes (decision 3), so no "resume" button is required.

It is **NOT**:

- an agent-reachable surface — the gate reads managed state and the meter; nothing exposes it to a
  running session;
- a mid-run throttle — it never touches an in-flight run, never lowers concurrency, never kills a
  session (decision 1);
- a manual-run blocker — manual `run_task` stays allowed with only a warning chip (decision 1);
- a new metric — it consumes the shipped `RateWindow.used_percent` (already normalized `0..=100`),
  and introduces the **first** threshold comparison in the codebase (there is none today — § 6f).

---

## 3. Design — tier by tier

### 3.1 The gate lives in the coordinator tick, mirroring the circuit breaker

The auto-loop's next-run decision is made **entirely in Rust**, in one place:
`orchestration/coordinator/auto_loop.rs`, `tick()` (`auto_loop.rs:114-148`). Its very first lines
are the gate battery:

```rust
async fn tick(app: &AppHandle) {
    let orch = app.state::<Orchestrator>();
    if !orch.auto.is_running() || orch.breaker.is_paused() {   // auto_loop.rs:116
        return;
    }
    // ... free_slots(), eligible_tasks(...).take(free), launch(app, id).await
}
```

The **circuit breaker is the exact prior art** to clone: `breaker.is_paused()` gates the tick so a
broken setup stops *starting new work* while in-flight runs finish untouched (`breaker.rs`,
`is_paused()` at `breaker.rs:86`). A *stop* (`auto_loop.rs:47-60`) interrupts every run; a *pause*
does not — this is precisely decision 1's "stops picking up NEW runs; running sessions finish
naturally." **Add a second, sibling gate condition:**

```rust
if !orch.auto.is_running() || orch.breaker.is_paused() {
    return;
}
if let Some(reason) = usage_throttle_reason(app) {   // NEW — § 3.2
    orch.enter_usage_pause(app, &reason);             // emits nc:loop "paused" + one-shot notify (§ 3.5/3.6)
    return;
}
orch.leave_usage_pause(app);                          // NEW — clears the latch + re-emits "running" on cool
// ... existing free_slots / select / launch
```

**Crucial difference from the breaker: the usage gate does NOT latch.** The breaker latches
`paused = true` until `resume_auto_loop` clears it (`breaker.rs:52-95`). The usage gate is a **live
condition re-checked every tick** — exactly like the existing `free_slots() == 0` early return
(`auto_loop.rs:120-123`). `usage_throttle_reason` returns `Some` while hot and `None` while cool,
so when the 10-min poll (or a focus refetch) drops the window under threshold, the very next tick
(interval `TICK_INTERVAL = 750ms`, `auto_loop.rs:22`) proceeds and launches again. **No resume
command, no user action** — this satisfies decision 3's "auto-resume when a subsequent poll shows
all windows back under threshold." (Terminal events already kick an immediate re-tick via
`orch.kick()`, so latency stays low.)

The `enter_usage_pause` / `leave_usage_pause` helpers own the transition bookkeeping (§ 3.5/§ 3.6):
a one-shot latch on the `Orchestrator` so the banner state + notification fire exactly once per
pause episode, not every 750ms.

### 3.2 `usage_throttle_reason` — the fail-open decision function

A pure-ish read over managed state, in a new `orchestration/coordinator/usage_gate.rs` (a sibling
of `submit.rs`, so `coordinator/mod.rs` stays a manifest). **Fail-open at every branch** — every
early `None` means "do not gate":

```rust
/// Some(reason) ⇒ the auto-loop should NOT pick up new runs this tick; None ⇒ proceed.
/// Fail-open: any uncertainty (meter off, snapshot stale/absent, provider not Ok) ⇒ None.
fn usage_throttle_reason(app: &AppHandle) -> Option<UsagePause> {
    let settings = app.state::<SettingsStore>();
    // (a) opt-in gate — the meter must be ON (decision 4). Threshold read here too.
    if !settings.with_settings(|s| s.usage_meter_enabled) { return None; }
    let threshold = settings.with_settings(|s| s.auto_pause_usage_threshold); // u8, default 90 (§ 4)

    let reg = app.state::<UsageRegistry>();
    // (b) freshness gate (decision 4): the in-process staleness clock. If we have never
    // polled, or the last poll is too old to trust, DO NOT gate. `stale_enough(max_age)`
    // already exists (registry.rs:115-120); reuse it with a generous max (e.g. 2× the
    // 600s poll interval) so a briefly-late poll doesn't fail-open prematurely.
    if reg.stale_enough(USAGE_TRUST_MAX_AGE) { return None; }

    let meter = reg.snapshot();                        // last-good UsageMeter (registry.rs:72-74)
    // (c) provider the runs use — v1: Claude. (Resolve from Settings.provider when Codex
    // runs land; for v1 pin "claude".)
    let row = meter.providers.iter().find(|p| p.provider == RUN_PROVIDER_ID)?;
    // (d) trust the number ONLY when the row is Ok and not stale (decision 4). Every other
    // status — Stale, RateLimited, Unauthorized, Unsupported, NotConnected, Disabled — is a
    // "do not trust as current" and therefore a fail-open.
    if row.status != UsageStatus::Ok || row.stale { return None; }

    // (e) ANY window crossing threshold triggers (decision 2): 5h OR weekly OR model-scoped.
    // Do NOT use compactWindows (it drops model-scoped) — scan ALL windows.
    let hot = row.windows.iter()
        .filter(|w| w.used_percent >= threshold as f64)
        .max_by(|a, b| a.used_percent.total_cmp(&b.used_percent))?; // the hottest, for the banner copy
    Some(UsagePause {
        provider: row.provider.clone(),
        window_label: hot.label.clone(),   // "Session (5h)", "Weekly", "Opus weekly", …
        used_percent: hot.used_percent,
        resets_at: hot.resets_at.clone(),  // ISO-8601, feeds "resumes ~HH:MM"
    })
}
```

Grounding notes (all verified against the shipped meter):
- `used_percent` is **normalized `0..=100` at parse time** in both providers (`claude.rs`
  `normalize_pct`, `codex.rs` clamp) — compare against a `0..100` threshold directly, never a
  `0..1` fraction.
- `kind` values are `"5h"`, `"weekly"`, `"weekly_opus"`, `"weekly_sonnet"`, `"model:<id>"`
  (Codex may emit `"extra_<i>"`). Decision 2 says **ANY** window, so the gate does **not** filter
  by `kind` — it scans `row.windows` whole. `label` is the human string for the banner.
- `status` / `stale` are the trust signals: `UsageStatus::Ok` + `!stale` is the only
  "number is current" state (all other variants ⇒ fail-open).
- `stale_enough(max_age)` (`registry.rs:115-120`) is the Rust-internal `Instant`-based staleness
  clock (`last_poll`), NOT the serialized ISO `updated_at` — it is the right freshness signal for
  a Rust consumer, and it already returns `true` (⇒ fail-open) before the first poll.

`RUN_PROVIDER_ID` is `"claude"` in v1 (matches the meter's provider-name vocabulary /
`provider::CLAUDE_PROVIDER_ID`). Widening to "the provider the runs actually use" (Codex) is a
one-line change when Codex runs ship (§ 11).

### 3.3 The `nc:loop` "paused" surface (no schema change)

The pause reflects to the web over the **existing** `nc:loop` event, exactly like the breaker.
`emit_state(app, "paused", Some(reason))` already exists and is what `useAutoLoop` reads
(`useAutoLoop.hooks.ts:33-40` inspects `loop.reason.toLowerCase().includes('circuit')`). Emit
`emit_state(app, "paused", Some("usage"))` (a free-string `reason`, matched web-side with
`includes('usage')`). **No `nc:loop` field is added** — the banner reads the window specifics
(label, %, `resets_at`) from the `nc:usage` snapshot the web already holds via `onUsageEvent` /
`getUsage` (§ 3.7). This keeps the loop contract untouched and the codegen surface small.

When the gate clears, `leave_usage_pause` re-emits `"running"` (the tick's normal end-state,
`auto_loop.rs:147`), and the breaker's own pause state (if any) still takes precedence in
`emit_state`'s ordering — usage-pause never masks a breaker pause and vice-versa. Precedence in
the tick is explicit: breaker first (`auto_loop.rs:116`), then usage.

### 3.4 Why NOT `submit_run` (the manual-run carve-out)

Manual and auto runs converge on **one** chokepoint: `submit_run(app, task_id, feed_breaker)`
(`orchestration/coordinator/submit.rs:38`). Manual `run_task` calls it with `feed_breaker = false`
(`sidecar/commands.rs:29-32`); the auto-loop's `launch` calls it with `true`
(`submit.rs:19-21`). A gate inside `submit_run` would block **both** — violating decision 1.
Therefore the gate is at the **tick** (`auto_loop.rs:116`), the one place ONLY the auto-loop
passes. Manual `run_task` is untouched at the seam; its "allowed but warned" behavior is a
**web-only chip** (§ 3.8), never a backend refusal.

### 3.5 One-shot latch — banner + notification fire once per episode

`enter_usage_pause` must fire the banner-signal and the OS notification **exactly once** on the
false→true transition, not every 750ms tick. Add a small latch to the `Orchestrator` (or its
`AutoLoop`), mirroring the breaker's "returns whether THIS failure caused the trip"
(`breaker.rs:52-66`):

```rust
// on the Orchestrator: usage_paused: AtomicBool (default false)
fn enter_usage_pause(&self, app: &AppHandle, pause: &UsagePause) {
    let first = !self.usage_paused.swap(true, Ordering::SeqCst);
    self.emit_state(app, "paused", Some("usage"));   // idempotent; cheap
    if first {
        notify_usage_pause(app, pause);              // § 3.6 — ONE notification (decision 3)
        tracing::info!(target: "nightcore", provider = %pause.provider,
            window = %pause.window_label, pct = pause.used_percent, "auto-loop usage-paused");
    }
}
fn leave_usage_pause(&self, app: &AppHandle) {
    if self.usage_paused.swap(false, Ordering::SeqCst) {
        // was paused, now cool — the tick will re-emit "running" as it launches.
        tracing::info!(target: "nightcore", "auto-loop usage-pause cleared; resuming");
    }
}
```

The latch resets on cool, so a later re-heat notifies again (a *new* episode) — matching decision
3's "when the pause first triggers" per-episode semantics. `stop_auto_loop` / `resume_auto_loop`
also clear the latch (a manual stop ends any episode).

### 3.6 The OS notification — clone `notify_task_complete` verbatim (no new dep)

**The notification plugin is already fully wired — this is NOT a new dependency (§ 10.3).**
`tauri-plugin-notification = "2.3"` is in `Cargo.toml:20`, initialized at `lib.rs:71`
(`.plugin(tauri_plugin_notification::init())`), and the capability `notification:default` is
granted in `capabilities/default.json:9`. The exact idiom to clone is the shipped
`notify_task_complete` (`sidecar/lifecycle.rs:66-85`):

```rust
fn notify_usage_pause(app: &AppHandle, pause: &UsagePause) {
    use tauri_plugin_notification::NotificationExt;
    let title = "Auto Mode paused";
    let body = format!("{} {} at {:.0}%", provider_display(&pause.provider),
        pause.window_label, pause.used_percent);   // our own text — NO token, NO endpoint body
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::debug!(target: "nightcore", error = %e, "usage-pause notification failed");
    }
}
```

Best-effort (a failed notification logs at `debug`, never surfaces), body carries only our trusted
text — never a credential or raw endpoint body (the meter's own logging discipline). The web JS
package `@tauri-apps/plugin-notification` is **not** installed and is **not** needed: firing from
Rust at the transition point is both the smallest path AND the correct one (the transition is
detected in the Rust tick, not on the web).

### 3.7 Web — the board banner (clone the breaker banner)

The dismissable-banner pattern already exists as the circuit-breaker "Resume" strip
(`board/Board/Board.tsx:85-108`) with its visibility hook `useBreakerBanner`
(`board/Board/Board.hooks.ts:100-119`, which re-shows on a fresh breaker). Add a **sibling**:

- **`useUsagePauseBanner(loop, usageMeter)`** in `Board.hooks.ts` — visible when
  `loop?.state === 'paused' && (loop.reason ?? '').includes('usage')` and not locally dismissed;
  re-shows when a fresh usage-pause arrives (reset `dismissed` when the paused-for-usage condition
  transitions false→true), exactly like `useBreakerBanner` resets on `breaker === null`.
- **A second conditional strip in `Board.tsx`** (~line 85, beside the breaker strip). Copy:
  *"Auto mode paused — {providerDisplay} {windowLabel} at {N}%, resumes ~{HH:MM}"*, computed from
  the **`nc:usage` snapshot** the board already receives (the hottest window ≥ threshold — the same
  scan as § 3.2, mirrored web-side from `RateWindow`). `resets_at` → `~HH:MM` via a local
  `formatResetClock(resetsAt)` (short time; `resets_at` is an ISO string, may be absent → omit the
  "resumes" clause). **No Resume button** (auto-resume, decision 3) — only a **Dismiss** ✕ (reuse
  `banner.dismiss`). The banner is cosmetic; the actual resume is the Rust tick.
- Deliver `loop` + the usage snapshot into the banner via the existing board-chrome context
  (`board/chrome.ts` `BoardChromeValue`; assembled in
  `app/AppShell/hooks/useBoardChromeValue.hooks.ts`), the same channel that already carries
  `breaker` / `onResume`.

### 3.8 Web — the gear-popover threshold slider (decision 2)

The Auto Mode gear popover is the `ToolbarOption` settings slot
(`ui/ToolbarOption/ToolbarOption.tsx:54-66`) whose content is `AutoModeOptions.tsx`
(`board/AutoModeOptions/AutoModeOptions.tsx`, today a single auto-commit switch), wired in
`board/BoardHeader/BoardHeader.tsx:104-118`. Add a **threshold row** below the auto-commit switch:

- **A raw `<input type="range" min={50} max={100>` slider** — there is **NO `Slider` primitive** in
  `components/ui/` (§ 6c). Clone the shipped concurrency slider idiom verbatim
  (`BoardHeader.tsx:86-96`: `<input type="range" min={1} max={6} className="… accent-primary" />`
  + a `font-mono` value readout). Label: *"Pause Auto Mode at usage"*; value shows `{N}%`.
- **Disabled/hint state when the meter is off:** the throttle only functions when the usage meter
  is enabled (decision 4). When `usageMeterEnabled` is false, render the slider **disabled** with a
  one-line hint (*"Enable the usage meter to use this"*) — the control is discoverable but inert,
  matching the backend fail-open.
- **Two new props** threaded through the existing chain, exactly like `autoCommitOnVerified`:
  `AutoModeOptions.types.ts` (`autoPauseUsageThreshold: number`,
  `onThresholdChange: (n: number) => void`, plus `usageMeterEnabled: boolean` for the disabled
  state) → `BoardHeader.tsx` → `board/chrome.ts` (`BoardChromeValue`) →
  `useBoardChromeValue.hooks.ts` (read `settings.settings?.autoPauseUsageThreshold ?? 90`; write via
  `applySettings({ autoPauseUsageThreshold: next })` — the same read/write pattern as
  `autoCommitOnVerified` at `useBoardChromeValue.hooks.ts:70`/`:55`).

### 3.9 Web — the manual-start warning chip (decision 1)

Manual `run_task` stays allowed; the chip is **advisory**. On the task card's Run affordance
(`board/actions.ts` `onRun`, wired on `TaskCard`), show a small warning chip **when the usage
snapshot is hot** — i.e. the same "any window ≥ threshold on the run provider, status Ok, meter
enabled" condition (§ 3.2), evaluated web-side from the `nc:usage` snapshot the app already holds
(via `onUsageEvent` / `getUsage`). The chip does NOT disable the button.

- **Chip primitive:** `ui/Badge/Badge.tsx` has only `neutral`/`primary` tones — use an inline
  warning class (`bg-warning`/`text-warning` or `destructive`; both tokens exist and are used by
  the meter's own `barTone` at 60/85). Copy: *"usage high"* with a tooltip
  *"Claude {window} at {N}% — this run counts against your limit."*
- Derive the hot flag once (a `useUsageHot(threshold)` selector over the meter snapshot + the
  threshold setting) and reuse it for both the chip and, if desired, a subtle Auto-Mode toolbar
  indicator. Keep it a pure derivation — no new command, no new channel.

---

## 4. Settings evolution (serde-additive)

One new global field on `Settings` (`store/settings/model.rs`), matching the
`auto_commit_on_verified` / `usage_meter_enabled` idiom exactly:

```rust
/// Usage-aware auto-mode throttle (spec 2026-07-11, decision 2): the % at which the
/// autonomous loop STOPS picking up new runs when the run provider's usage meter shows
/// ANY rate-limit window (5h / weekly / model-scoped) at or above this level. Range
/// 50..=100, default 90. Only consulted when `usage_meter_enabled` is on AND the meter
/// snapshot is fresh (decision 4 — fail-open); it never blocks manual runs and never
/// interrupts an in-flight session. Global-only (like `auto_commit_on_verified`).
/// Serde-additive: a settings file written before this field loads as 90.
#[serde(default = "default_usage_pause_threshold")]
pub auto_pause_usage_threshold: u8,
```

with `fn default_usage_pause_threshold() -> u8 { 90 }` (beside `default_run_mode_value` /
`default_true`), the matching `Option<u8>` on `SettingsPatch` (`store/settings/patch.rs`, beside
`usage_meter_enabled: Option<bool>` at `:188-192`, `#[cfg_attr(test, ts(optional))]`), the merge
line (`if let Some(v) = patch.auto_pause_usage_threshold { self.auto_pause_usage_threshold = v; }`),
and the `Default` value (`auto_pause_usage_threshold: 90` in `Settings::default()`). It rides the
existing `Settings` ts-rs export — a `cargo test` regenerates `Settings.ts` + `SettingsPatch.ts`
with the new key.

**"Enabled implicit via meter" (decision 4).** There is deliberately **no** separate
`auto_pause_enabled` flag. The gate is armed whenever the usage meter is on; the threshold is the
only knob. A user who never enabled the meter never sees the gate act (the slider shows disabled,
§ 3.8; `usage_throttle_reason` returns `None` at branch (a), § 3.2). This keeps the setting surface
minimal and the fail-open invariant single-sourced.

**Clamp on write.** The web clamps the slider to `50..=100` before it lands; the Rust side treats
an out-of-range stored value defensively (a value `< 50` or `> 100` still just compares against
`used_percent`, so it can only ever be more/less eager — never a crash). Optionally clamp in the
patch merge for tidiness.

---

## 5. Codegen / lint lockstep checklist

| Concern | File | Action |
|---|---|---|
| Settings additive field | `store/settings/model.rs`, `patch.rs` | `auto_pause_usage_threshold: u8` (`#[serde(default = "default_usage_pause_threshold")]`) + `Option<u8>` patch twin + `Default = 90` + merge line + the `default_usage_pause_threshold` fn. |
| ts-rs regen | `bindings/*`, `apps/web/src/lib/generated/{Settings,SettingsPatch}.ts` | `cargo test` from `apps/desktop/src-tauri` regenerates + **commit** `Settings.ts` / `SettingsPatch.ts`. Never hand-edit (§ 6a). |
| `nc:loop` reason value | `orchestration/coordinator/auto_loop.rs` (+ `emit_state` callers) | Emit `reason = "usage"`; **no `LoopEnvelope` field added** — reuse the free-string `reason` the breaker already uses. No `CHANNELS`/`generated.rs` edit (§ 3.3). |
| No new command (v1) | — | The gate is internal to the tick; **no new `#[tauri::command]`** is required. (The notification fires in-process via `NotificationExt`.) If a future manual "resume now" is wanted it reuses `resume_auto_loop` — out of v1. |
| No new event channel | — | Pause rides `nc:loop`; banner specifics ride the existing `nc:usage`. **Do not add an `nc:*` channel** (avoids the two-tier `CHANNELS`↔`generated.rs` codegen lockstep). |
| Web folder-per-component | `packages/eslint-plugin/` | `AutoModeOptions/` gains a slider row; `Board.hooks.ts` gains `useUsagePauseBanner`; a `useUsageHot` selector. No NEW component folder is strictly required (edits land in existing folders); any new file satisfies thin-shell / hook-budget / ≤400-line gates. Validate `bun run lint`. |
| No new ESLint rule | `tools/lint-meta/`, `agent-contract-parity` | **Add none** (the AGENTS.md-parity trap). Validate `bun run lint:meta` = zero on a clean tree. |

---

## 6. Repo-specific traps (mandatory — each has bitten this codebase or is provable here)

**(a) ts-rs codegen is regenerate-and-diff, from `src-tauri`.** The new Settings field exports only
during `cargo test` run **from `apps/desktop/src-tauri`** (root `cargo` no-ops — no root
`Cargo.toml`). Run `cargo test`, then **commit** the regenerated `apps/web/src/lib/generated/*` +
`bindings/*`. A missing/uncommitted regen reds the CI drift guard.

**(b) The gate must NOT latch and must NOT interrupt.** Two invariants, both provable against
`auto_loop.rs`/`breaker.rs`: (1) the usage gate is a **live** per-tick check (like `free_slots()==0`
at `auto_loop.rs:120-123`), **not** a latched breaker (`breaker.rs`) — or it won't auto-resume
(decision 3); (2) it is placed in `tick()` before `launch`, and it calls **neither** `stop()` nor
`interrupt_all()` — a *stop* interrupts in-flight runs (`auto_loop.rs:47-60`), which violates
decision 1. Pause = "don't start new"; never "kill running."

**(c) There is no `Slider` primitive.** `components/ui/` has none; every slider in the app is a raw
`<input type="range">` (the concurrency slider at `BoardHeader.tsx:86-96` is the canonical idiom).
Do **not** add a `ui/Slider/` component for a single 50–100 range — clone the range-input pattern
in `AutoModeOptions.tsx` (§ 3.8).

**(d) `useAutoCommit` does not exist — do not "mirror" it.** Auto-commit-on-verified is implemented
**entirely in Rust** (`sidecar/verification/handlers.rs:459` `maybe_auto_commit_on_verified`); the
`model.rs:79-88` doc comment describing a "web observer" is **stale**. The real web-observer idioms
to clone are `useAutoLoop` (subscribes `nc:loop`) and `useUsageMeter` (subscribes `nc:usage`). The
gate itself is Rust (§ 3.1); only the banner/chip/slider are web.

**(e) serde-additive settings.** `auto_pause_usage_threshold` MUST be `#[serde(default = …)]` with a
`90` default so a settings file written before this feature loads cleanly. Every prior Settings
field upholds this (see `usage_meter_enabled` at `model.rs:155-156`); do not break it.

**(f) This is the FIRST threshold gate on `used_percent`.** No existing code compares a usage
window to a threshold — the only percent comparisons are cosmetic (`UsageMeter.hooks.ts` `barTone`
at 60/85) or parse-time normalization/clamps. There is no prior "hot" helper to reuse; build the
comparison fresh (§ 3.2 Rust, § 3.9 web) against the guaranteed-`0..=100` `used_percent`. Align the
web chip's copy with the meter's `barTone` tokens for visual consistency, but the *gate* threshold
is the user's setting, not `barTone`'s 85.

**(g) Fail-open is a correctness requirement, not a nicety.** The usage endpoints are
reverse-engineered/unversioned (predecessor spec § 3.6). Every uncertain branch in
`usage_throttle_reason` returns `None` (do not gate): meter disabled, `stale_enough` true, provider
row missing, `status != Ok`, `stale == true`. A telemetry hiccup must never halt the loop — an
over-run window is the lesser failure. Fixture/unit-test each fail-open branch (§ 7).

**(h) The provider is pinned to Claude in v1.** `RUN_PROVIDER_ID = "claude"` (decision 2). Do not
scan Codex's row for the gate in v1 even though the meter carries it — the runs use Claude. Widening
to "the provider the runs use" is a named § 11 follow-up, one line at branch (c) of § 3.2.

---

## 7. Test plan (headless where possible; clone the named idioms)

1. **`usage_throttle_reason` — the gate decision (Rust, `usage_gate.rs` tests).** Drive a synthetic
   `UsageRegistry` + `SettingsStore` (or inject the snapshot + threshold):
   - meter **disabled** ⇒ `None` (branch a);
   - **stale** snapshot (`stale_enough` true / never polled) ⇒ `None` (branch b);
   - provider row `Stale`/`RateLimited`/`Unauthorized`/`Unsupported`/`NotConnected` ⇒ `None`
     (branch d) — one case per non-`Ok` variant;
   - all windows under threshold ⇒ `None`;
   - a **5h** window ≥ threshold ⇒ `Some` with that window's label/%/resets_at;
   - a **model-scoped** (`kind = "model:…"`) window ≥ threshold, with 5h/weekly cool ⇒ `Some`
     (proves ANY window, not just compact ones — decision 2);
   - threshold boundary: `used_percent == threshold` ⇒ hot (`>=`).
2. **Live, non-latching resume (Rust, `auto_loop`/`usage_gate` tests).** With an injected reason
   fn: hot ⇒ tick returns without launching; flip to cool ⇒ next tick launches. Assert the gate
   never calls `stop`/`interrupt_all` (trap b). Assert the one-shot latch fires the notification
   hook once across N hot ticks, and again after a cool→hot re-heat.
3. **Manual-run carve-out (Rust).** Assert `run_task` → `submit_run(_, _, false)` is unaffected by
   a hot gate (the gate is only in `tick`, not `submit_run`) — extend the existing
   `manual_run_never_feeds_the_breaker` sibling (`submit.rs:227-260`) with a usage-hot fixture.
4. **Settings additive (Rust).** A `Settings` JSON without `autoPauseUsageThreshold` loads as `90`;
   round-trips; a patch sets it; clamp behavior at 50/100 (clone the existing additive-field
   settings tests in `store/settings/mod.rs`).
5. **`nc:loop` reason (Rust).** Entering the pause emits `state: "paused", reason: "usage"`;
   leaving re-emits `"running"`. Breaker-pause still takes precedence when both are active.
6. **Web banner (`Board.hooks.ts`/`Board.test.tsx`).** `useUsagePauseBanner` visible on
   `paused` + `reason includes 'usage'`; dismiss hides; a fresh episode re-shows; copy renders the
   hottest window + `~HH:MM` from a mock `nc:usage` snapshot; absent `resets_at` omits the "resumes"
   clause. Clone the `useBreakerBanner` test.
7. **Web slider (`AutoModeOptions.test.tsx`/`.stories.tsx`).** Range 50–100; change fires
   `onThresholdChange`; disabled + hint when `usageMeterEnabled` is false. Stories: enabled@90,
   enabled@50, disabled.
8. **Web chip (`useUsageHot` + task-card story).** Chip shows when the snapshot is hot + meter
   enabled; hidden when meter off / cool / not-Ok; the Run button stays enabled in all cases
   (decision 1).

---

## 8. Verification gates (run per PR)

```
bun run lint                              # eslint-plugin (AutoModeOptions slider, Board banner, chip)
bun run lint:meta                         # zero violations on a clean tree (no channel/rule drift)
bun run --filter @nightcore/web typecheck # root tsc -b does NOT cover apps/web
bun run --filter @nightcore/web test      # web banner/slider/chip tests
cargo fmt --all --check                   # MUST run from apps/desktop/src-tauri (root no-ops silently)
cargo clippy --all-targets                # from src-tauri; green on macOS AND Linux CI
cargo test                                # from src-tauri: usage_gate + settings tests + ts-rs regen (commit generated + bindings)
bun run dogfood:engine                    # manual: enable meter, force a window ≥ threshold (or lower the slider under
                                          #   the live %), start Auto Mode → loop stops picking new; an in-flight run finishes;
                                          #   ONE OS notification fires; banner shows "…resumes ~HH:MM"; manual Run still works
                                          #   with a chip; drop the threshold back up → next tick resumes automatically
```

- `cargo test` performs the ts-rs regen (the Settings field) — commit `Settings.ts` /
  `SettingsPatch.ts` + `bindings/*`; never hand-edit.
- The fail-open branches (§ 6g) are unit-tested headless — the `dogfood:engine` pass is for the
  happy-path pause/resume + notification + banner, which need a live meter reading.

---

## 9. PR slicing (ONE PR; independently green)

### PR — usage-aware auto-mode throttle (Rust gate + Settings field + web gear/banner/chip)

- **Scope (Rust):** `orchestration/coordinator/usage_gate.rs` (`usage_throttle_reason`, the
  `UsagePause` struct, `RUN_PROVIDER_ID`, `USAGE_TRUST_MAX_AGE`); the tick-gate insertion
  (`auto_loop.rs:116`) + `enter_usage_pause`/`leave_usage_pause` + the `usage_paused` latch on the
  `Orchestrator`; the `emit_state(_, "paused", "usage")` wiring; `notify_usage_pause`
  (clone of `sidecar/lifecycle.rs:66-85`); the `auto_pause_usage_threshold` Settings field + patch
  twin + default + merge + ts-rs regen.
- **Scope (web):** the `AutoModeOptions` threshold slider + the two new props threaded through
  `BoardHeader` → `chrome.ts` → `useBoardChromeValue.hooks.ts`; the `useUsagePauseBanner` hook + the
  second banner strip in `Board.tsx`; the `useUsageHot` selector + the manual-start warning chip.
- **Encodes:** the pre-launch tick gate (decision 1); the ANY-window ≥ threshold, Claude-only,
  slider-driven threshold (decision 2); auto-resume + dismissable banner + one-shot notification
  (decision 3); the meter-enabled-AND-fresh fail-open at every branch (decision 4).
- **Green because:** additive Settings field (regenerates its own TS), additive Rust gate function
  gated behind the opt-in meter, additive web UI over existing contexts. `cargo test` covers the
  gate decision + fail-open branches headless (no live network); `bun run lint` / web tests cover
  the UI. Fully testable with injected snapshots.

> **Optional slice** (only if a reviewer prefers): land the Rust gate + Settings field first (green
> on its own — the loop simply gates with no UI copy yet, the notification still fires), then the
> web banner/slider/chip second. The notification does **not** force a separate PR — the plugin is
> already wired (§ 3.6). One PR is the default.

---

## 10. Loud flags — shipped code vs the locked decisions

1. **The run-pickup is Rust, NOT a web observer — the "mirror `useAutoCommit`" premise is wrong on
   two counts.** (a) The auto-loop's next-run decision is `tick()` in
   `orchestration/coordinator/auto_loop.rs:114-148` (Rust); the web `useAutoLoop` only *reflects*
   `nc:loop` and toggles start/stop — it never selects or spawns a run. (b) `useAutoCommit` **does
   not exist**: auto-commit-on-verified is Rust (`verification/handlers.rs:459`); the `model.rs`
   doc comment claiming a web observer is stale. **Consequence:** the gate MUST live in the Rust
   tick. A web observer that called `stopAutoLoop` on "hot" would **interrupt in-flight runs**
   (`stop()` → `interrupt_all()`, `auto_loop.rs:47-60`), directly violating decision 1 ("running
   sessions finish naturally"). This is the single most important correction in the spec.

2. **The circuit breaker is the exact, shipped model — reuse its *pause* semantics, not a new
   mechanism.** `breaker.is_paused()` already gates the tick (`auto_loop.rs:116`) so new pickups
   stop while running sessions finish. The usage gate is a sibling condition — but **non-latching**
   (the breaker latches until `resume_auto_loop`; the usage gate re-checks live, so it auto-resumes
   per decision 3). Do not reach for the breaker's `reset`/latch machinery.

3. **The notification plugin is PRESENT and fully wired — NOT absent.** Contrary to a "check whether
   a plugin exists / spec adding one" assumption: `tauri-plugin-notification = "2.3"` is in
   `Cargo.toml:20`, `.plugin(tauri_plugin_notification::init())` runs at `lib.rs:71`, and
   `notification:default` is granted at `capabilities/default.json:9`. A working precedent already
   fires OS notifications (`notify_task_complete`, `sidecar/lifecycle.rs:66-85`, gated on
   `notify_on_complete`). So the notification is **zero new deps, zero new capability** — fire it
   from Rust at the pause transition. The web JS package `@tauri-apps/plugin-notification` is not
   installed and is not needed. **This is why the whole feature stays ONE PR.**

4. **No `nc:loop` schema change and no new `nc:*` channel are needed.** The pause reuses the
   free-string `reason` the breaker already sets (matched web-side with `includes('usage')`), and
   the banner reads window specifics from the existing `nc:usage` snapshot. This deliberately dodges
   the two-tier `CHANNELS`↔`generated.rs` codegen lockstep the predecessor spec flagged.

5. **No `Slider` primitive exists.** The 50–100% slider is a raw `<input type="range">` cloned from
   the concurrency slider (`BoardHeader.tsx:86-96`); do not introduce a `ui/Slider/` component for
   one control.

6. **`used_percent` is already normalized `0..=100`** (verified in `claude.rs`/`codex.rs` parse) —
   compare directly against the threshold; there is no `0..1`-vs-`0..100` ambiguity to guard, and
   there is no existing threshold-gate code to extend (this is the first).

---

## 11. Deferred / out of v1 (named so they are not silently in-scope)

- **Tray icon / menu-bar surface** — explicitly OUT (decision 3, "NO tray icon in this run").
- **Codex-provider gating** — v1 pins `RUN_PROVIDER_ID = "claude"` (decision 2). Widening to "the
  provider the runs actually use" is a one-line change at § 3.2 branch (c) when Codex runs ship.
- **A manual "resume now" override** while usage-paused — unnecessary (auto-resume, decision 3);
  if ever wanted it reuses `resume_auto_loop`.
- **A separate `auto_pause_enabled` flag** — rejected; the gate is armed implicitly by the meter
  being enabled (decision 4 / § 4).
- **Concurrency-scaling instead of pause** (e.g. drop `max_concurrency` as the window heats) — OUT;
  decision 1 is a binary pause of *new* pickups, never a mid-run resize.
- **Per-window / per-model thresholds** — v1 is one global threshold vs ANY window (decision 2).
- **Gating manual runs** — permanently rejected (decision 1); manual stays advisory-chip only.
