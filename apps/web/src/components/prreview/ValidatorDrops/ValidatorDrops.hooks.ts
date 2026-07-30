/** State for the {@link ValidatorDrops} disclosure. The component is a controlled
 *  composition; only the collapse holds local state (allowlisted to the hooks file
 *  by the no-state-in-component-body rule). */
import { useCallback, useState } from 'react';

/** Collapse state for the dropped-findings list (COLLAPSED by default — the drops
 *  are an audit trail, not the review). */
export interface DropsCollapse {
  expanded: boolean;
  toggle: () => void;
}

export function useDropsCollapse(): DropsCollapse {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  return { expanded, toggle };
}
