/** Presentational sub-parts for ModelSelect: the grouped option rows, the
 *  provider group headings, the inline effort radiogroup, and the loading/error
 *  catalog states. No state — every value arrives via props. */
import { BrainIcon, CheckIcon, RefreshIcon } from '../icons';
import type { KnownProviderId } from '../ProviderIcon';
import { ProviderIcon } from '../ProviderIcon';
import type { EffortRowView, ModelRow } from './ModelSelect.types';

/** The uppercase field label shared by the model + effort sections. */
export const LABEL =
  'font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground';

/** Class string for a listbox option row in its highlighted/idle state. */
function optionRowClass(highlighted: boolean): string {
  return `flex w-full items-center gap-2 rounded-[8px] px-2 py-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    highlighted ? 'bg-primary/[0.12]' : 'hover:bg-white/[0.04]'
  }`;
}

/** Class string for the per-model tier badge. */
function tierBadgeClass(tier: string): string {
  return `rounded px-1.5 py-px text-[9px] font-semibold uppercase tracking-wide ${
    tier === 'Premium' ? 'bg-primary/[0.16] text-primary' : 'bg-white/[0.06] text-muted-foreground'
  }`;
}

/** Class string for an effort chip in its selected/idle state. */
function effortChipClass(selected: boolean): string {
  return `rounded-[9px] border px-2.5 py-1.5 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
    selected
      ? 'border-primary/60 bg-primary/[0.1] text-foreground'
      : 'border-border bg-white/[0.02] text-muted-foreground hover:border-white/20'
  }`;
}

/** Props for a single model option row. */
interface ModelOptionRowProps {
  row: ModelRow;
  /** Whether this row is the keyboard highlight (drives `aria-selected`). */
  highlighted: boolean;
  /** Whether this row is the currently-chosen model (drives the check mark). */
  current: boolean;
  disabled: boolean;
  onHighlight: (index: number) => void;
  onSelect: (value: string | null) => void;
}

/** One selectable model: a check for the chosen model, the provider glyph, the
 *  label, an optional tier badge, and a one-line capability description.
 *  `mousedown` is suppressed so picking with the pointer doesn't blur the trigger
 *  (which would close the menu before the click lands). */
export function ModelOptionRow({
  row,
  highlighted,
  current,
  disabled,
  onHighlight,
  onSelect,
}: ModelOptionRowProps) {
  return (
    <button
      id={row.id}
      type="button"
      role="option"
      aria-selected={highlighted}
      aria-label={row.label}
      disabled={disabled}
      onMouseEnter={() => onHighlight(row.index)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSelect(row.value)}
      className={optionRowClass(highlighted)}
    >
      <span className="flex w-3.5 shrink-0 justify-center text-primary" aria-hidden>
        {current && <CheckIcon size={13} />}
      </span>
      {row.provider !== null ? (
        <ProviderIcon provider={row.provider} size={14} className="shrink-0 text-muted-foreground" />
      ) : (
        <span className="w-3.5 shrink-0" aria-hidden />
      )}
      <span className="text-[13px] font-medium text-foreground">{row.label}</span>
      {row.tier !== null && (
        <span className={tierBadgeClass(row.tier)} aria-hidden>
          {row.tier}
        </span>
      )}
      <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground" aria-hidden>
        {row.description}
      </span>
    </button>
  );
}

/** A small uppercase provider heading inside the listbox. The enclosing group
 *  carries the accessible name, so this is decorative. */
export function ProviderGroupLabel({
  provider,
  label,
}: {
  provider: KnownProviderId | null;
  label: string;
}) {
  return (
    <div
      role="presentation"
      className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
    >
      {provider !== null && (
        <ProviderIcon provider={provider} size={12} className="text-muted-foreground" />
      )}
      {label}
    </div>
  );
}

/** One effort radio chip. */
function EffortChip({
  selected,
  label,
  title,
  disabled,
  onClick,
}: {
  selected: boolean;
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={effortChipClass(selected)}
    >
      {label}
    </button>
  );
}

/** The inline, model-aware reasoning-effort radiogroup. Surfaces only the effort
 *  levels the selected model supports (the premium tier unlocks the higher ones),
 *  plus the always-present Inherit + `none` chips, and hints when the model
 *  reasons adaptively. Not a nested popover — an inline row. */
export function EffortRow({
  effort,
  disabled,
  onPick,
}: {
  effort: EffortRowView;
  disabled: boolean;
  onPick: (effort: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5">
        <BrainIcon size={12} className="text-muted-foreground" />
        <span className={LABEL}>Reasoning effort</span>
        {effort.adaptive && effort.activeLabel !== null && (
          <span className="text-[10px] font-medium text-primary/80">
            · {effort.activeLabel} decides adaptively
          </span>
        )}
      </div>
      <div role="radiogroup" aria-label="Reasoning effort" className="flex flex-wrap gap-2">
        <EffortChip
          selected={effort.value === null}
          label="Inherit"
          title={effort.adaptive ? 'Adaptive — the model decides' : 'Use the default effort'}
          disabled={disabled}
          onClick={() => onPick(null)}
        />
        {effort.options.map((option) => (
          <EffortChip
            key={option.id}
            selected={effort.value === option.id}
            label={option.label}
            title={option.description}
            disabled={disabled}
            onClick={() => onPick(option.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** The skeleton shown while the catalog is loading (async seam). */
export function CatalogStatus() {
  return (
    <div
      role="status"
      aria-label="Loading models"
      className="flex items-center gap-2 rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-[12.5px] text-muted-foreground"
    >
      <RefreshIcon size={13} className="animate-spin text-muted-foreground" aria-hidden />
      Loading models…
    </div>
  );
}

/** The soft error + retry shown when the whole catalog read failed. */
export function CatalogError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-destructive/40 bg-destructive/[0.08] px-3 py-2.5 text-[12.5px] text-foreground">
      <span className="truncate text-muted-foreground">{message}</span>
      {onRetry !== undefined && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-auto flex shrink-0 items-center gap-1 rounded-[8px] border border-border px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:border-white/20"
        >
          <RefreshIcon size={12} aria-hidden />
          Retry
        </button>
      )}
    </div>
  );
}
