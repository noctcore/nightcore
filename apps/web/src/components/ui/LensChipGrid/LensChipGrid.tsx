/**
 * The shared scan CONFIGURE form pieces, hoisted out of the three cloned
 * `RunControls` forms (Insight / Scorecard / Harness) and the PR-Review lens
 * row: the selected/unselected chip classes ({@link chipClass}), the lens chip
 * grid with its All/None header ({@link LensChipGrid}), and the full form shell
 * ({@link ScanConfigForm}) — heading, a model/effort picker slot, an
 * extra-section slot, the chip grid, and the primary CTA + cost hint.
 */
import { Button } from '../Button';
import { Spinner } from '../Spinner';
import type {
  LensChipGridProps,
  ScanConfigFormProps,
} from './LensChipGrid.types';

const CHIP =
  'rounded-[10px] border px-3 py-1.5 text-[12.5px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

/** Lens chip classes for the selected/unselected states. */
export function chipClass(selected: boolean): string {
  return `${CHIP} ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

const SECTION_LABEL =
  'font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground';

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
        <span className={SECTION_LABEL}>{heading}</span>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onSelectAll}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            All
          </button>
          <button
            type="button"
            onClick={onSelectNone}
            className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
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
  scrollable = true,
  ...chipGrid
}: ScanConfigFormProps<K>) {
  const form = (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-7 px-6 py-10">
      <span className={SECTION_LABEL}>Run config</span>

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
        <p className="text-[12px] text-muted-foreground">{hint}</p>
      </div>
    </div>
  );

  if (!scrollable) return form;
  return <div className="flex min-h-0 flex-1 overflow-y-auto">{form}</div>;
}
