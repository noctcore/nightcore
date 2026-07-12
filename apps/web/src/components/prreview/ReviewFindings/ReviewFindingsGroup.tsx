/** The collapsible per-severity group header for the PR Review results grid: a
 *  tri-state checkbox (sweeps the group's open findings) beside a labelled collapse
 *  toggle carrying the group count. */
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from '@/components/ui';

import { SEVERITY_META } from '../prreview.constants';
import type { GroupTriState, SeverityGroupView } from './ReviewFindings.hooks';

/** The tri-state box glyph: filled check (all), a dash (some), or an empty box. */
function GroupCheckboxBox({ triState }: { triState: GroupTriState }) {
  const filled = triState !== 'unchecked';
  return (
    <span
      aria-hidden
      className={`flex h-[17px] w-[17px] shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        filled
          ? 'border-primary bg-primary text-primary-foreground'
          : 'border-border bg-white/[0.02]'
      }`}
    >
      {triState === 'checked' && <CheckIcon size={12} />}
      {triState === 'indeterminate' && (
        <span className="h-[2px] w-[9px] rounded-full bg-primary-foreground" />
      )}
    </span>
  );
}

/** A collapsible severity group header: a tri-state checkbox (sweeps the group's
 *  open findings) beside a labelled collapse toggle carrying the group count. The
 *  two controls are siblings (never nested), so both stay keyboard-reachable. */
export function SeverityGroupHeader({
  group,
  onToggleExpand,
  onToggleGroup,
}: {
  group: SeverityGroupView;
  onToggleExpand: () => void;
  onToggleGroup: () => void;
}) {
  const meta = SEVERITY_META[group.severity];
  const Chevron = group.expanded ? ChevronDownIcon : ChevronRightIcon;
  const ariaChecked: boolean | 'mixed' =
    group.triState === 'checked'
      ? true
      : group.triState === 'indeterminate'
        ? 'mixed'
        : false;

  return (
    <div className="flex items-center gap-2.5 pt-3">
      <button
        type="button"
        role="checkbox"
        aria-checked={ariaChecked}
        aria-label={`Select all open ${meta.label} findings`}
        disabled={group.openCount === 0}
        onClick={onToggleGroup}
        className="rounded-[6px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40"
      >
        <GroupCheckboxBox triState={group.triState} />
      </button>
      <button
        type="button"
        aria-expanded={group.expanded}
        onClick={onToggleExpand}
        className="flex flex-1 items-center gap-2 rounded-[6px] py-0.5 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Chevron size={13} className="shrink-0 text-muted-foreground" />
        <span
          className={`font-mono text-2xs font-semibold uppercase tracking-[0.08em] ${meta.tone}`}
        >
          {meta.label}
        </span>
        <span className="font-mono text-2xs text-muted-foreground">
          {group.findings.length}
        </span>
      </button>
    </div>
  );
}
