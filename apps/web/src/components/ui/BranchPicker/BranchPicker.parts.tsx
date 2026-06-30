/** Presentational sub-parts for BranchPicker: the grouped option rows and the
 *  section labels. No state — every value arrives via props. */
import { CheckIcon } from '../icons';
import type { BranchRow } from './BranchPicker.types';

/** Compose the "↑{ahead} ↓{behind}" tracking label, or null when both are zero. */
function aheadBehindLabel(ahead: number, behind: number): string | null {
  const parts: string[] = [];
  if (ahead > 0) parts.push(`↑${ahead}`);
  if (behind > 0) parts.push(`↓${behind}`);
  return parts.length > 0 ? parts.join(' ') : null;
}

/** A small uppercase section heading inside the listbox (Local / Remote). The
 *  enclosing group carries the accessible name, so this is decorative. */
export function SectionLabel({ children }: { children: string }) {
  return (
    <div
      role="presentation"
      className="px-2 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground/70"
    >
      {children}
    </div>
  );
}

/** Props for a single branch option row. */
interface BranchOptionRowProps {
  row: BranchRow;
  highlighted: boolean;
  onHighlight: (index: number) => void;
  onSelect: (name: string) => void;
}

/** One selectable branch: a check for the current branch, the name, and an
 *  ahead/behind tracking chip when the branch diverges from its upstream.
 *  `mousedown` is suppressed so picking with the pointer doesn't blur the input
 *  (which would close the menu before the click lands). */
export function BranchOptionRow({ row, highlighted, onHighlight, onSelect }: BranchOptionRowProps) {
  const { branch } = row;
  const tracking = aheadBehindLabel(branch.ahead, branch.behind);
  return (
    <button
      id={row.id}
      type="button"
      role="option"
      aria-selected={highlighted}
      onMouseEnter={() => onHighlight(row.index)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onSelect(branch.name)}
      className={`flex w-full items-center gap-1.5 rounded-[8px] px-2 py-1.5 text-left transition-colors ${
        highlighted ? 'bg-primary/[0.12]' : 'hover:bg-white/[0.04]'
      }`}
    >
      <span className="flex w-3.5 shrink-0 justify-center text-primary" aria-hidden>
        {branch.isCurrent && <CheckIcon size={13} />}
      </span>
      <span className="truncate text-[13px] text-foreground">{branch.name}</span>
      {tracking !== null && (
        <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground" aria-hidden>
          {tracking}
        </span>
      )}
    </button>
  );
}
