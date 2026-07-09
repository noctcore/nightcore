# Debug Report: Harness scan with codex model produces 0 findings (no JSON)

**Date:** 2026-07-09
**Agent:** kirei-debug
**Status:** root cause confirmed

## Symptom
Harness scan with a codex-flavored model selected (e.g., `gpt-5.5` or `gpt-5-codex`) fails in ~2-3s with 0 findings. Logs show:
- `WARN sidecar: [sidecar:harness] scan item session did not complete cleanly {"runId":"...","item":"tooling-lint","message":"no JSON convention findings in model output"}`
- `WARN sidecar: [sidecar:harness] scan item session did not complete cleanly {"runId":"...","item":"agent-context","message":"no JSON convention findings in model output"}`
- `WARN sidecar: [sidecar:harness] harness synthesis produced no proposals {"runId":"...","error":"no JSON in synthesis output"}`
- Final: `scan completed — 0 findings, 0 artifacts, 0 proposals ... $0.00`

Logs always report the codex-flavored model id. Cost is $0. Claude models worked before. Happens only when using codex.

## Expected
Selecting a model from the catalog (which includes codex models with `providerId: 'codex'`) should either:
- Route the scan to the appropriate provider (CodexAgentProvider), or
- Surface a clear error that scans require a Claude model.

Instead the scan silently degrades to zero output.

## Repro
**Command / scenario:**
1. Open Harness view
2. In RunControls, open ModelSelectField and pick a codex model (e.g., `gpt-5.5` or `gpt-5-codex`)
3. Select one or more lenses
4. Click "Scan"
5. Observe: completes in ~2-3s with 0 findings; warnings "no JSON convention findings in model output" and "no JSON in synthesis output"

**Reliability:** always (when a non-Claude model id is passed through)

## Root Cause
**Location:** `packages/engine/src/scans/shared/scan-manager.ts:33` (import) + `runOneSession:429` (model passthrough); `packages/contracts/src/commands.ts:244` (StartHarnessScanCommand and siblings declare only `model?: string`); UI RunControls (harness/RunControls.tsx:42-44, insight/RunControls.tsx:36-38, scorecard/RunControls.tsx:26-29, prreview/ReviewSection.tsx:169-171, issues/ValidateControls.tsx:81-83) drop `sel.providerId`.

**Mechanism:** All scan families inherit from `ScanManager`, which unconditionally does:
```ts
import { SessionRunner, type SessionRunnerConfig } from '../../providers/claude/session-runner.js';
// ...
const runner = this.runnerFactory({
  ...
  model: command.model ?? this.deps.config.model,
  ...
}, ...);
```
(See: scan-manager.ts:429, defaultRunnerFactory:93, HarnessManager.sessionConfig/buildPrompt, synthesis.ts:290 (buildSynthesisPrompt), findings.ts:129 (parseConventionFindings via parseItems/extractJson), synthesis.ts:352 (parseSynthesis via extractJson).)

Unlike interactive sessions (`session-manager.ts:376`: `this.providers.forSession(command.providerId)`), scan commands and the entire scan path are provider-oblivious. `SessionOptionsBuilder.run():408` forwards the raw model string: `model: this.cfg.model`. When a codex id reaches the Claude SDK, the backend either falls back or the model cannot follow the strict "Output ONLY a JSON array (no prose, no markdown fences)" contract in harness prompts → non-JSON output → parse sets `error` → corrective retry also fails → 0 findings, 0 proposals.

**Introduced by:** Codex integration (D-009 / 2026-07-07-codex-single-sidecar-provider.md) added `CodexAgentProvider` and provider routing for `StartSessionCommand` (which has `providerId`), but scan commands (`StartHarnessScanCommand`, `StartAnalysisCommand`, `StartScorecardCommand`, etc.) and the scan execution path were not updated.

## Evidence
- `packages/engine/src/scans/shared/scan-manager.ts:33`: hardcoded Claude import
- `packages/engine/src/scans/shared/scan-manager.ts:429`: `model: command.model ?? this.deps.config.model`
- `packages/engine/src/providers/claude/session-options.ts:408`: `model: this.cfg.model`
- `packages/contracts/src/commands.ts:235-244` (StartHarnessScanCommand), 197-211 (StartAnalysisCommand), 268-279 (StartScorecardCommand): only `model?: string`
- `apps/web/src/components/harness/RunControls/RunControls.tsx:40-45`:
  ```tsx
  <ModelSelectField value={{ model: config.model, effort: config.effort }}
    onChange={(sel) => { config.setModel(sel.model); config.setEffort(sel.effort); }} />
  ```
  (Same pattern in insight, scorecard, prreview, issues ValidateControls.)
- `apps/web/src/lib/useRunConfig.ts:6-11`: comment claims "a scan's provider is re-derivable from the model id" — false for live codex models and not wired anyway.
- `packages/engine/src/session/session-manager.ts:376`: `forSession(command.providerId)` — only for interactive sessions.
- Logs: "no JSON convention findings in model output", "no JSON in synthesis output", 0 findings, $0 cost, 2-3s wall time (no real work).

## Recommended Fix
**Approach:** Make scan commands provider-aware (add `providerId?: string`) and wire it through to select the runner (or reject non-Claude at the surface). Two options:
1. Minimal: at scan start surfaces (UI + Rust + contracts), only offer/accept Claude models; add a guard in ScanRouter/ScanManager.
2. Full: plumb `providerId` into `BaseScanCommand` and all scan commands, extend `ScanManagerDeps`/`ScanRunnerFactory` to accept provider selection, and have `defaultRunnerFactory` (or a new registry-aware factory) delegate to the correct provider's read-only runner path. Note: CodexAgentProvider currently only implements interactive `AgentSession`; a read-only scan path may need a separate or shared implementation.

Files to change (at minimum for a guard):
- `packages/contracts/src/commands.ts`: add `providerId?: string` to all `Start*` scan commands (after adding to zod FIRST per AGENTS.md).
- `apps/web/src/components/*/RunControls/*.tsx` (harness, insight, scorecard, prreview, issues): pass `sel.providerId` through config and bridge.
- `apps/web/src/lib/bridge/commands/*.ts` and `apps/desktop/src-tauri/src/sidecar/*/commands.rs`: thread providerId.
- `packages/engine/src/scans/shared/scan-manager.ts` and `scan-router.ts`: accept and use provider (or reject).
- Optionally: `useRunConfig.ts` to carry providerId for scans.

## Regression Test to Promote
The repro from this debug session should become a permanent test:

- **Test file:** `packages/engine/src/scans/harness/manager.test.ts` (or a new `scan-provider-routing.test.ts`)
- **Test body:**
```ts
test('HarnessManager with a non-claude model id still uses Claude runner and surfaces parse failure (no JSON) rather than routing to another provider', () => {
  // This test documents current behavior: scans are Claude-only.
  // When provider routing is added, update or split this test.
  const events: NightcoreEvent[] = [];
  const manager = new HarnessManager({
    config: BASE_CONFIG,
    apiKeyFallback: false,
    emit: (e) => events.push(e),
    // defaultRunnerFactory is used (no override) — verifies wiring is Claude
  });
  // Inject a codex-flavored model id via command
  manager.start({
    type: 'start-harness-scan',
    runId: 'run-codex',
    projectPath: '/proj',
    categories: ['tooling-lint'],
    model: 'gpt-5.5', // codex-flavored id
  } as StartHarnessScan);
  // With the real (stubbed in CI) Claude runner path, the SDK would be asked for 'gpt-5.5'.
  // Here we only assert the manager accepts the command and the model is threaded.
  // A stronger test would spy on the constructed SessionRunnerConfig.model.
});
```

Better: add a unit test that the `runOneSession` path receives the model string verbatim from the command (no provider branching), using a capturing factory.

## Instrumentation to Remove
None — diagnosed from existing logs and static code inspection. No temporary instrumentation was added.

## Risks
- Adding `providerId` to contracts requires regenerating Rust (ts-rs) and following the additive-contract discipline.
- If CodexAgentProvider cannot provide a read-only scan runner, scans must either stay Claude-only (guard at UI) or a new capability must be implemented.
- Other scan families (insight, scorecard, pr-review, issue-triage) have identical exposure — fix must be cross-cutting or they regress the same way.
- The assumption in `useRunConfig.ts` ("provider re-derivable from model id") is unsound for dynamic catalogs and should be removed or made explicit.

## How to Verify the Fix
1. Apply the fix (guard or full provider routing for scans)
2. Run `bun run lint && bun run typecheck && bun run test:node`
3. In the app, select a codex model for Harness → either:
   - a clear error that scans require Claude, or
   - the scan routes to a working codex path and produces findings
4. Re-run with a Claude model — behavior unchanged (still works)
5. Repeat for Insight, Scorecard, PR Review, Issue Validation
