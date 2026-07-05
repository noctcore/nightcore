/** State + pure helpers for the {@link ReviewPosition}. The component itself is a
 *  controlled composition; only the verdict-reasoning collapse holds local
 *  state (allowlisted to the hooks file by the no-state-in-component-body rule). */
import { useCallback, useState } from 'react';

import { mergeVerdictMeta } from '../prreview.constants';
import type { ReviewPositionData } from './ReviewPosition.types';

/** Whether the position layer has anything to render — an absent verdict, no
 *  contradictions, not stale, and no follow-up all mean the section is silent. */
export function hasPositionContent(data: ReviewPositionData): boolean {
  return (
    mergeVerdictMeta(data.verdict ?? '') !== null ||
    data.reconciliation.length > 0 ||
    data.stale ||
    data.followup !== null
  );
}

/** Collapse state for the verdict reasoning (closed by default). */
export interface ReasoningCollapse {
  expanded: boolean;
  toggle: () => void;
}

export function useReasoningCollapse(): ReasoningCollapse {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  return { expanded, toggle };
}
