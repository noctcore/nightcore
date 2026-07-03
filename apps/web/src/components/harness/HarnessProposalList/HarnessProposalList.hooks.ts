import { useCallback, useLayoutEffect, useRef } from 'react';

import type { ProposedArtifactVM } from '../harness.types';

/** Wrap `onOpen` in a stable identity backed by a ref so the memoized
 *  `ArtifactCard` is not re-rendered just because the parent view handed down a
 *  fresh inline handler on every render. The ref is kept pointing at the latest
 *  `onOpen`, so a click always invokes the current handler — identity-only
 *  stabilization, never stale. This makes `React.memo` on the card effective: on a
 *  single artifact's status change (apply/dismiss) only that one card re-renders;
 *  the rest keep a stable `artifact` + `onOpen` and skip. */
export function useStableOnOpen(
  onOpen: (artifact: ProposedArtifactVM) => void,
): (artifact: ProposedArtifactVM) => void {
  const ref = useRef(onOpen);
  useLayoutEffect(() => {
    ref.current = onOpen;
  });
  return useCallback((artifact: ProposedArtifactVM) => ref.current(artifact), []);
}
