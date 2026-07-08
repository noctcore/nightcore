/** A segmented (pill-group) selector bound to a string value. */
import type { ReactNode } from 'react';

import { DURATION, EASE, m } from '../motion';
import type { SegmentedProps } from './Segmented.types';

/** A segmented selector with a sliding active-pill highlight. The segments are
 *  equal-width (an `inline-grid` of `1fr` columns), so the highlight glides between
 *  them via a pure `x` transform — no `layout`/`layoutId` FLIP (excluded by the
 *  `domAnimation` bundle and unnecessary here). `disabled` renders it visible-but-
 *  inert (e.g. for a not-yet-built control). */
export function Segmented({ options, value, onChange, disabled }: SegmentedProps): ReactNode {
  const count = options.length;
  const activeIndex = Math.max(
    0,
    options.findIndex(([v]) => v === value),
  );

  return (
    <div
      className={`relative inline-grid shrink-0 rounded-lg border border-border bg-black/20 p-0.5 ${
        disabled ? 'opacity-40' : ''
      }`}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      {/* The sliding highlight sits behind the labels (z-0); its width is one
          segment and it translates by whole segments to the active one. */}
      <m.span
        aria-hidden
        className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-md bg-primary/[0.18]"
        style={{ width: `calc((100% - 0.25rem) / ${count})` }}
        initial={false}
        animate={{ x: `${activeIndex * 100}%` }}
        transition={{ duration: DURATION.base, ease: EASE.outQuint }}
      />
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          className={`relative z-10 shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors disabled:cursor-not-allowed ${
            v === value ? 'text-primary' : 'text-muted-foreground enabled:hover:text-foreground'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
