/** An editable switch toggle bound to a persisted boolean. */
import type { ReactNode } from 'react';

import type { ToggleProps } from './Toggle.types';

/** An editable switch toggle bound to a persisted boolean setting. */
export function Toggle({ on, onChange, label }: ToggleProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`inline-flex h-[18px] w-[32px] items-center rounded-full px-0.5 transition-colors ${on ? 'bg-primary' : 'bg-white/[0.12]'}`}
    >
      <span
        className={`h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : ''}`}
      />
    </button>
  );
}
