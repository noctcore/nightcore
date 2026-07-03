import { useCallback, useLayoutEffect, useRef } from 'react';

import type { InsightFinding } from '../insight.types';

/** Wrap `onOpen` in a stable identity backed by a ref so the memoized
 *  `FindingCard` is not re-rendered just because the parent view handed down a
 *  fresh inline handler on every render. The ref is kept pointing at the latest
 *  `onOpen`, so a click always invokes the current handler — the stabilization is
 *  identity-only, never stale. This is what makes `React.memo` on the card
 *  effective: on a single finding's status change only that one card (whose object
 *  ref changed) re-renders; the rest keep a stable `finding` + `onOpen` and skip. */
export function useStableOnOpen(
  onOpen: (finding: InsightFinding) => void,
): (finding: InsightFinding) => void {
  const ref = useRef(onOpen);
  useLayoutEffect(() => {
    ref.current = onOpen;
  });
  return useCallback((finding: InsightFinding) => ref.current(finding), []);
}
