/**
 * The shared scan CONFIGURE form pieces, hoisted out of the three cloned
 * `RunControls` forms (Insight / Scorecard / Harness) and the PR-Review lens
 * row: the selected/unselected chip classes ({@link chipClass}), the lens chip
 * grid with its All/None header ({@link LensChipGrid}), and the full form shell
 * ({@link ScanConfigForm}) — heading, a model/effort picker slot, an
 * extra-section slot, the chip grid, and the primary CTA + cost hint.
 */
import { Button } from '../Button';
import { SectionLabel } from '../SectionLabel';
import { Spinner } from '../Spinner';
import { useScanLimits } from './LensChipGrid.hooks';
import type {
  LensChipGridProps,
  ScanConfigFormProps,
} from './LensChipGrid.types';

const CHIP =
  'rounded-nc border px-3 py-1.5 text-xs-plus font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/** Lens chip classes for the selected/unselected states. */
export function chipClass(selected: boolean): string {
  return `${CHIP} ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

/** The lens chip grid: a header row (heading + All/None) over toggleable,
 *  `aria-pressed` icon chips. */
export function LensChipGrid<K extends string>({
  heading,
  chips,
  selected,
  onToggle,
  onSelectAll,
  onSelectNone,
}: LensChipGridProps<K>) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <SectionLabel>{heading}</SectionLabel>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-2xs font-medium text-muted-foreground hover:text-foreground"
          >
            All
          </button>
          <button
            type="button"
            onClick={onSelectNone}
            className="text-2xs font-medium text-muted-foreground hover:text-foreground"
          >
            None
          </button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {chips.map((chip) => {
          const Icon = chip.icon;
          const on = selected.has(chip.key);
          return (
            <button
              key={chip.key}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(chip.key)}
              className={`inline-flex items-center gap-1.5 ${chipClass(on)}`}
            >
              <Icon size={13} />
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The full CONFIGURE form: heading, a model/effort picker slot, an optional
 *  extra section (Insight's scope radio), the lens chip grid, and the primary
 *  CTA with its cost hint. A controlled, purely-presentational view of the
 *  lifted run-config state. */
/** Format a dollar amount for the ceiling note: cents precision, since a divided
 *  per-pass budget is routinely sub-dollar ($5 over 8 categories = $0.63). */
function usd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

/**
 * The spend/turn ceiling this run will actually dispatch under (#401), shown BEFORE
 * the user clicks the most expensive button in the app.
 *
 * Renders nothing when Settings carries no ceiling — the pre-#401 state, and still
 * the default — so it only ever appears to explain a real cap.
 *
 * The budget line names both numbers: what EACH pass gets, and the total it was
 * divided from. A lone "$0.63" would look alarmingly unlike the $5 the user typed.
 */
function ScanCeilingNote({
  passCount,
  unitLabel,
}: {
  passCount: number;
  unitLabel: string;
}) {
  const limits = useScanLimits(passCount);
  const { maxBudgetUsdPerPass, maxBudgetUsdTotal, maxTurnsPerPass } = limits;

  const parts: string[] = [];
  if (maxBudgetUsdPerPass !== undefined && maxBudgetUsdTotal !== undefined) {
    parts.push(
      `${usd(maxBudgetUsdPerPass)} per ${unitLabel} · ${usd(maxBudgetUsdTotal)} max`,
    );
  }
  if (maxTurnsPerPass !== undefined) {
    parts.push(`${maxTurnsPerPass} turns per ${unitLabel}`);
  }
  if (parts.length === 0) return null;

  return (
    <p className="text-xs-flat text-muted-foreground">
      <span className="font-semibold text-foreground">Ceiling</span>{' '}
      {parts.join(' · ')}
      <span className="sr-only">
        , from your Settings run limits; the scan stops at this ceiling
      </span>
    </p>
  );
}

export function ScanConfigForm<K extends string>({
  picker,
  beforeChips,
  canRun,
  isStarting,
  onRun,
  ctaIcon,
  ctaBusyIcon,
  ctaLabel,
  ctaClassName = 'w-full sm:w-auto',
  hint,
  unitLabel,
  scrollable = true,
  ...chipGrid
}: ScanConfigFormProps<K>) {
  const form = (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-6 py-10">
      <SectionLabel>Run config</SectionLabel>

      {/* Model + effort — the family composes the shared picker into this slot */}
      {picker}

      {beforeChips}

      <LensChipGrid {...chipGrid} />

      {/* Primary CTA + hint */}
      <div className="flex flex-col gap-2">
        <Button
          disabled={!canRun || isStarting}
          aria-busy={isStarting}
          onClick={onRun}
          className={ctaClassName}
        >
          {isStarting ? (ctaBusyIcon ?? <Spinner size={15} />) : ctaIcon}
          {isStarting ? 'Starting…' : ctaLabel}
        </Button>
        <p className="text-xs-flat text-muted-foreground">{hint}</p>
        <ScanCeilingNote
          passCount={chipGrid.selected.size}
          unitLabel={unitLabel}
        />
      </div>
    </div>
  );

  if (!scrollable) return form;
  return <div className="flex min-h-0 flex-1 overflow-y-auto">{form}</div>;
}
