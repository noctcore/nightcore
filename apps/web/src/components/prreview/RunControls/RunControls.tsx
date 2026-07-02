/** The PR Review CONFIGURE screen: the run-configuration form. */
import { Button, GithubIcon, ModelEffortPicker, Spinner } from '@/components/ui';

import { ALL_LENSES, LENS_META } from '../prreview.constants';
import type { RunControlsProps } from './RunControls.types';

const CHIP =
  'rounded-[10px] border px-3 py-1.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

function chipClass(selected: boolean): string {
  return `${CHIP} ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

/** The CONFIGURE screen: the PR-number input, the lens chip grid, model/effort,
 *  and the big Review CTA. A controlled, purely-presentational view of the lifted
 *  `config` state. The live readout + Cancel live on the RUNNING screen. */
export function RunControls({ config, isStarting, onReview }: RunControlsProps) {
  const {
    prNumber,
    setPrNumber,
    prNumberValid,
    model,
    setModel,
    effort,
    setEffort,
    selected,
    toggle,
    selectAll,
    selectNone,
    orderedSelected,
    canReview,
  } = config;

  const lensCount = orderedSelected.length;
  // A non-empty-but-invalid input surfaces an inline hint; an empty input is
  // neutral (the CTA is simply disabled until the user types a valid number).
  const showPrError = prNumber.trim().length > 0 && !prNumberValid;

  return (
    <div className="flex min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-6 py-10">
        <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
          Run config
        </span>

        {/* PR number */}
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="pr-review-number"
            className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground"
          >
            Pull request
          </label>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-muted-foreground">#</span>
            <input
              id="pr-review-number"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={prNumber}
              placeholder="e.g. 128"
              aria-invalid={showPrError}
              onChange={(e) => setPrNumber(e.target.value)}
              className={`w-[160px] rounded-[10px] border bg-black/20 px-3 py-2 font-mono text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 [appearance:textfield] focus:border-primary/60 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none ${
                showPrError ? 'border-destructive/60' : 'border-border'
              }`}
            />
          </div>
          {showPrError ? (
            <p className="text-[12px] text-destructive">
              Enter a positive PR number.
            </p>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              Reviews the pull request&apos;s diff — no checkout, read-only.
            </p>
          )}
        </div>

        {/* Model + effort (reuses the shared picker for parity) */}
        <ModelEffortPicker
          model={model}
          effort={effort}
          onChangeModel={setModel}
          onChangeEffort={setEffort}
        />

        {/* Lenses */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
              Lenses ({lensCount}/{ALL_LENSES.length})
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={selectAll}
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                All
              </button>
              <button
                type="button"
                onClick={selectNone}
                className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                None
              </button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_LENSES.map((lens) => {
              const Meta = LENS_META[lens];
              const Icon = Meta.icon;
              const on = selected.has(lens);
              return (
                <button
                  key={lens}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(lens)}
                  className={`inline-flex items-center gap-1.5 ${chipClass(on)}`}
                >
                  <Icon size={13} />
                  {Meta.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Primary CTA + hint */}
        <div className="flex flex-col gap-2">
          <Button
            disabled={!canReview || isStarting}
            aria-busy={isStarting}
            onClick={onReview}
            className="w-full sm:w-auto"
          >
            {isStarting ? <Spinner size={15} /> : <GithubIcon size={15} />}
            {isStarting ? 'Starting…' : 'Review PR'}
          </Button>
          <p className="text-[12px] text-muted-foreground">
            Reviews the PR diff across {lensCount}{' '}
            {lensCount === 1 ? 'lens' : 'lenses'} · ~Claude {model ?? 'default'} ·
            cost depends on diff size.
          </p>
        </div>
      </div>
    </div>
  );
}
