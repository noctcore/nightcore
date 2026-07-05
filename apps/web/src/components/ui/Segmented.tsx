/** A segmented (pill-group) selector bound to a string value. */
import type { ReactNode } from 'react';

/** Props for {@link Segmented}. */
export interface SegmentedProps {
  options: [value: string, label: string][];
  value: string;
  onChange: (value: string) => void;
  /** Render the control visible-but-inert (e.g. a not-yet-built affordance). */
  disabled?: boolean;
}

/** A segmented selector. `disabled` renders it visible-but-inert (e.g. for a
 *  not-yet-built control). */
export function Segmented({ options, value, onChange, disabled }: SegmentedProps): ReactNode {
  return (
    <div
      className={`inline-flex shrink-0 rounded-lg border border-border bg-black/20 p-0.5 ${disabled ? 'opacity-40' : ''}`}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${
            v === value
              ? 'bg-primary/[0.18] text-primary'
              : 'text-muted-foreground enabled:hover:text-foreground'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
