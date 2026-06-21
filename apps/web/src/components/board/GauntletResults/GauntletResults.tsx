import { Button, ChecksIcon } from '@/components/ui';
import { STEP_STATUS_GLYPH, STEP_STATUS_TEXT } from './GauntletResults.hooks';
import type { GauntletResultsProps } from './GauntletResults.types';

/** The pre-merge readiness gauntlet panel (M4, §C): a "Run checks" trigger over
 *  the detected typecheck → lint → test steps, each with its command and
 *  pass/fail/skip status. Pure presentational — the run + result state is owned
 *  by the detail panel. */
export function GauntletResults({ result, running, onRun }: GauntletResultsProps) {
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Readiness gauntlet
        </h3>
        {result !== null && (
          <span
            className={`font-mono text-[10px] font-semibold uppercase tracking-[0.06em] ${
              result.passed ? 'text-success' : 'text-destructive'
            }`}
          >
            {result.passed ? 'Passed' : `Failed at ${result.failedStep ?? 'unknown'}`}
          </span>
        )}
        <Button
          variant="secondary"
          className="ml-auto"
          disabled={running}
          onClick={onRun}
        >
          <ChecksIcon size={14} />
          {running ? 'Running…' : 'Run checks'}
        </Button>
      </div>

      {result === null ? (
        <p className="text-sm text-muted-foreground">
          {running ? 'Running checks…' : 'Run the gauntlet to gate the merge.'}
        </p>
      ) : result.steps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tooling detected — the gauntlet passes trivially.
        </p>
      ) : (
        <ul className="space-y-1">
          {result.steps.map((step) => (
            <li
              key={step.name}
              className="flex items-center gap-2 font-mono text-xs"
            >
              <span className={`w-3 text-center ${STEP_STATUS_TEXT[step.status]}`}>
                {STEP_STATUS_GLYPH[step.status]}
              </span>
              <span className="text-foreground">{step.name}</span>
              <span className="truncate text-muted-foreground">{step.command}</span>
              {step.exitCode !== undefined && step.status === 'failed' && (
                <span className="ml-auto text-destructive">exit {step.exitCode}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
