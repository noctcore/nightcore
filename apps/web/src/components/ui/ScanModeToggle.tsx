/** The Standard/Deep 2-chip radio shared by the scan families' CONFIGURE screens
 *  (issue #294). One presentational toggle so Insight/Harness/PR-Review render the
 *  deep-mode opt-in identically; the hint reads in each family's unit noun. */
import { rovingKeydown } from '@/lib/roving-keydown';
import { deepModeMeta } from '@/lib/scan-run';

import { chipClass } from './LensChipGrid';
import { SectionLabel } from './SectionLabel';

export interface ScanModeToggleProps {
  /** Whether DEEP mode is selected. */
  deep: boolean;
  /** Toggle DEEP on/off. */
  onToggle: (deep: boolean) => void;
  /** The per-pass unit noun for the hint copy (`category` / `lens`). */
  unitNoun: string;
}

/** A controlled Standard/Deep radio group. */
export function ScanModeToggle({ deep, onToggle, unitNoun }: ScanModeToggleProps) {
  const meta = deepModeMeta(unitNoun);
  return (
    <div className="flex flex-col gap-1.5">
      <SectionLabel>Mode</SectionLabel>
      <div role="radiogroup" aria-label="Mode" className="flex gap-2">
        {(['standard', 'deep'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={deep === (m === 'deep')}
            title={meta[m].hint}
            tabIndex={deep === (m === 'deep') ? 0 : -1}
            onClick={() => onToggle(m === 'deep')}
            onKeyDown={rovingKeydown}
            className={chipClass(deep === (m === 'deep'))}
          >
            {meta[m].label}
          </button>
        ))}
      </div>
    </div>
  );
}
