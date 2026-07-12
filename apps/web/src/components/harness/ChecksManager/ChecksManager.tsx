/** The Checks Manager — the armed-checks panel on the Enforce stage. Lists every
 *  Structure-Lock check armed in `.nightcore/harness.json` (its command, kind,
 *  enabled state, per-check timeout, and last on-demand result), and lets the user
 *  run them all now, or edit / disable / remove any of them. The zero-agent-cost
 *  gauntlet these checks drive is otherwise invisible until it blocks a task, so
 *  this panel makes the enforcement surface readable and editable. Rendered purely
 *  from `useChecksManager`. */
import {
  Button,
  ConfirmDialog,
  EditIcon,
  PlayIcon,
  Spinner,
  Toggle,
  TrashIcon,
  VerifiedIcon,
} from '@/components/ui';
import type {
  ArmedCheck,
  ArmedCheckOutcome,
  ArmedChecksLastRun,
  RuleValidationResult,
} from '@/lib/bridge';
import { formatRelativeTime } from '@/lib/formatters';

import { useChecksManager } from './ChecksManager.hooks';
import type { ChecksEditVM, ChecksManagerProps,ChecksManagerVM } from './ChecksManager.types';

/** The kinds a check may be armed/edited as — the armable allowlist (kept in
 *  lockstep with the Rust `ARMABLE_CHECK_KINDS`; the wire strings are stable). */
const ARMABLE_KINDS = [
  'lint-plugin',
  'dependency-cruiser',
  'coverage-threshold',
  'lockfile-lint',
  'env-contract',
  'secret-scan',
  'mutation-score',
  'ast-grep',
  'api-extractor',
] as const;

type OutcomeStatus = ArmedCheckOutcome['status'];

const STATUS_GLYPH: Record<OutcomeStatus, string> = {
  passed: '✓',
  failed: '✕',
  skipped: '–',
  flaky: '~',
};

const STATUS_TEXT: Record<OutcomeStatus, string> = {
  passed: 'text-success',
  failed: 'text-destructive',
  skipped: 'text-muted-foreground',
  flaky: 'text-warning',
};

const FIELD_INPUT =
  'w-full rounded-[8px] border border-border bg-black/20 px-2.5 py-1.5 font-mono text-xs-plus text-foreground outline-none focus:border-primary';

function formatDurationMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** The run-level banner: pass/fail of the last on-demand run + when it ran. */
function LastRunBanner({ lastRun }: { lastRun: ArmedChecksLastRun }) {
  return (
    <div className="flex items-center gap-2 text-2xs-plus">
      <span
        className={`font-mono font-semibold uppercase tracking-[0.06em] ${
          lastRun.passed ? 'text-success' : 'text-destructive'
        }`}
      >
        {lastRun.passed ? 'All passed' : `Failed at ${lastRun.failedCheck ?? 'unknown'}`}
      </span>
      <span className="text-muted-foreground">· ran {formatRelativeTime(lastRun.ranAt)} ago</span>
    </div>
  );
}

/** One check's last on-demand outcome: glyph + label + exit/duration + failure tail. */
function CheckResult({ result }: { result: ArmedCheckOutcome }) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2 font-mono text-2xs">
        <span className={STATUS_TEXT[result.status]}>
          {STATUS_GLYPH[result.status]} {result.status}
        </span>
        {result.exitCode !== undefined && result.status === 'failed' && (
          <span className="text-destructive">exit {result.exitCode}</span>
        )}
        {result.durationMs !== undefined && (
          <span className="text-muted-foreground">{formatDurationMs(result.durationMs)}</span>
        )}
      </div>
      {result.output !== undefined && result.status !== 'passed' && (
        <pre className="max-h-32 overflow-auto rounded-[6px] border border-border bg-black/30 px-2 py-1.5 font-mono text-3xs-plus text-muted-foreground">
          {result.output}
        </pre>
      )}
    </div>
  );
}

type ValidationOutcome = RuleValidationResult['outcome'];

/** The tint per RuleTester verdict: a probe/pass is good, a failed rule is a hard
 *  fail, a load/setup error is a warning (the check may still be fine — the runner
 *  just couldn't reach the rule). */
const VALIDATION_TONE: Record<ValidationOutcome, string> = {
  passed: 'text-success',
  probed: 'text-success',
  failed: 'text-destructive',
  error: 'text-warning',
};

const VALIDATION_LABEL: Record<ValidationOutcome, string> = {
  passed: 'Rule validated',
  probed: 'Real rule (structural probe passed)',
  failed: 'Rule failed validation',
  error: 'Could not validate',
};

/** One check's last "Validate rule" verdict: the RuleTester outcome + case tally +
 *  any soft error the runner reported (a rule that wouldn't load, etc.). */
function ValidationResult({ result }: { result: RuleValidationResult }) {
  const total = result.validTotal + result.invalidTotal;
  const passed = result.validPassed + result.invalidPassed;
  return (
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex items-center gap-2 font-mono text-2xs">
        <span className={VALIDATION_TONE[result.outcome]}>
          {result.outcome === 'failed' || result.outcome === 'error' ? '✕' : '✓'}{' '}
          {VALIDATION_LABEL[result.outcome]}
        </span>
        {total > 0 && (
          <span className="text-muted-foreground">
            {passed}/{total} cases
          </span>
        )}
        {result.eslintVersion !== undefined && (
          <span className="text-muted-foreground">eslint {result.eslintVersion}</span>
        )}
      </div>
      {result.error !== undefined && (
        <pre className="max-h-32 overflow-auto rounded-[6px] border border-border bg-black/30 px-2 py-1.5 font-mono text-3xs-plus text-muted-foreground">
          {result.error}
        </pre>
      )}
    </div>
  );
}

/** The inline edit form for a check (name / kind / command / timeout). */
function EditForm({ edit }: { edit: ChecksEditVM }) {
  const draft = edit.draft;
  if (draft === null) return null;
  return (
    <div className="flex flex-col gap-2 rounded-[9px] border border-primary/40 bg-primary/[0.04] p-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
          Name
          <input
            className={FIELD_INPUT}
            value={draft.name}
            onChange={(e) => edit.change({ name: e.target.value })}
          />
        </label>
        <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
          Kind
          <select
            className={FIELD_INPUT}
            value={draft.kind}
            onChange={(e) => edit.change({ kind: e.target.value })}
          >
            {ARMABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-2xs text-muted-foreground">
        Command
        <input
          className={FIELD_INPUT}
          value={draft.command}
          onChange={(e) => edit.change({ command: e.target.value })}
          placeholder="npx eslint ."
        />
      </label>
      <label className="flex w-40 flex-col gap-1 text-2xs text-muted-foreground">
        Timeout (ms)
        <input
          className={FIELD_INPUT}
          value={draft.timeoutMs}
          onChange={(e) => edit.change({ timeoutMs: e.target.value })}
          placeholder="default"
          inputMode="numeric"
        />
      </label>
      {edit.error !== null && <p className="text-2xs text-destructive">{edit.error}</p>}
      <div className="flex items-center gap-2">
        <Button onClick={edit.save} disabled={edit.saving} aria-busy={edit.saving}>
          {edit.saving ? <Spinner size={14} /> : null}
          Save
        </Button>
        <Button variant="ghost" onClick={edit.cancel} disabled={edit.saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** One armed-check row (or its inline edit form when this row is being edited). */
function CheckRow({ check, vm }: { check: ArmedCheck; vm: ChecksManagerVM }) {
  const editingThis = vm.edit.draft?.originalName === check.name;
  if (editingThis) return <EditForm edit={vm.edit} />;

  // Only a `lint-plugin` check is a RuleTester-validatable rule; other kinds have no
  // rule module to probe.
  const canValidate = check.kind === 'lint-plugin';
  const validating = vm.validate.pendingName === check.name;
  const validation = vm.validate.results[check.name];
  const validationError = vm.validate.errors[check.name];

  return (
    <div
      className={`flex flex-col gap-1 rounded-[9px] border border-border bg-card/40 p-3 ${
        check.enabled ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-center gap-2">
        <Toggle
          on={check.enabled}
          onChange={(next) => vm.toggle(check.name, next)}
          label={`${check.name} enabled`}
        />
        <span className="font-mono text-xs-plus font-semibold text-foreground">{check.name}</span>
        <span className="rounded-[5px] border border-border px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          {check.kind}
        </span>
        {vm.pendingName === check.name && <Spinner size={12} />}
        <div className="ml-auto flex items-center gap-1">
          {canValidate && (
            <button
              type="button"
              aria-label={`Validate rule ${check.name}`}
              className="rounded-[6px] p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
              onClick={() => vm.validate.start(check)}
              disabled={validating}
              aria-busy={validating}
              title="Validate this rule with ESLint's RuleTester"
            >
              {validating ? <Spinner size={14} /> : <VerifiedIcon size={14} />}
            </button>
          )}
          <button
            type="button"
            aria-label={`Edit ${check.name}`}
            className="rounded-[6px] p-1 text-muted-foreground hover:text-foreground"
            onClick={() => vm.edit.start(check)}
          >
            <EditIcon size={14} />
          </button>
          <button
            type="button"
            aria-label={`Remove ${check.name}`}
            className="rounded-[6px] p-1 text-muted-foreground hover:text-destructive"
            onClick={() => vm.remove.request(check)}
          >
            <TrashIcon size={14} />
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2 font-mono text-2xs text-muted-foreground">
        <span className="truncate">{check.command}</span>
        {check.timeoutMs != null && (
          <span className="shrink-0">· timeout {formatDurationMs(check.timeoutMs)}</span>
        )}
      </div>
      {check.lastResult !== undefined && <CheckResult result={check.lastResult} />}
      {validation !== undefined && <ValidationResult result={validation} />}
      {validationError !== undefined && (
        <p className="mt-1 font-mono text-2xs text-destructive">
          Could not validate: {validationError}
        </p>
      )}
    </div>
  );
}

/** The armed-checks panel body. */
export function ChecksManager({ vm: injected }: ChecksManagerProps = {}) {
  const built = useChecksManager();
  const vm = injected ?? built;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-6 py-5">
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-3">
            <div className="flex flex-col">
              <h2 className="text-[15px] font-semibold text-foreground">Armed checks</h2>
              <p className="text-2xs-plus text-muted-foreground">
                Deterministic gates that run before every reviewer and at merge — the
                project&apos;s own harness, enforced.
              </p>
            </div>
            <Button
              variant="secondary"
              className="ml-auto"
              onClick={vm.run.start}
              disabled={vm.run.running}
              aria-busy={vm.run.running}
            >
              {vm.run.running ? <Spinner size={14} /> : <PlayIcon size={14} />}
              {vm.run.running ? 'Running…' : 'Run armed checks now'}
            </Button>
          </div>
          {vm.lastRun !== null && <LastRunBanner lastRun={vm.lastRun} />}
        </header>

        {vm.loadError !== null && (
          <p className="rounded-md border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-2xs-plus text-destructive">
            Could not read the armed checks: {vm.loadError}
          </p>
        )}
        {vm.run.error !== null && (
          <p className="rounded-md border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-2xs-plus text-destructive">
            Run failed: {vm.run.error}
          </p>
        )}
        {vm.actionError !== null && (
          <p className="rounded-md border border-destructive/40 bg-destructive/[0.08] px-3 py-2 text-2xs-plus text-destructive">
            {vm.actionError}
          </p>
        )}

        {vm.loading ? (
          <p className="text-xs-plus text-muted-foreground">Loading armed checks…</p>
        ) : vm.checks.length === 0 ? (
          <p className="rounded-[9px] border border-dashed border-border px-4 py-6 text-center text-xs-plus text-muted-foreground">
            No checks armed yet. Arm a generated ESLint plugin or convention check from the
            Harden stage to enforce it here.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {vm.checks.map((check) => (
              <CheckRow key={check.name} check={check} vm={vm} />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={vm.remove.target !== null}
        title="Remove this armed check?"
        message={
          <>
            Remove <span className="font-mono">{vm.remove.target?.name}</span> from this
            project&apos;s harness? The gauntlet will stop running it. You can re-arm it later.
          </>
        }
        confirmLabel="Remove"
        destructive
        busy={vm.remove.busy}
        onConfirm={vm.remove.confirm}
        onCancel={vm.remove.cancel}
      />
    </div>
  );
}
