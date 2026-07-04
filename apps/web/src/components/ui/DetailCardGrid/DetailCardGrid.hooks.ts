import { Children, type ReactNode, useCallback, useState } from 'react';

/** Result of {@link usePagedChildren}. */
export interface PagedChildren {
  /** The card nodes to actually mount (capped to the revealed window). */
  visible: ReactNode[];
  /** How many card nodes are withheld behind the "show more" affordance. */
  hiddenCount: number;
  /** Reveal one more page of cards. */
  showMore: () => void;
}

/** Cap the number of mounted cards to a growable window.
 *
 *  A repo-wide scan can produce hundreds of findings; mounting them all at once
 *  is hundreds of live subtrees + fiber overhead (layout/paint stalls on open and
 *  resize). This mounts only the first `pageSize` and reveals more on demand,
 *  bounding the mount count without touching the responsive CSS-grid layout or its
 *  scroll behavior. Ordering is preserved — the window is always a prefix. */
export function usePagedChildren(children: ReactNode, pageSize: number): PagedChildren {
  const all = Children.toArray(children);
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const showMore = useCallback(
    () => setVisibleCount((count) => count + pageSize),
    [pageSize],
  );

  const visible = all.length > visibleCount ? all.slice(0, visibleCount) : all;
  return { visible, hiddenCount: all.length - visible.length, showMore };
}
