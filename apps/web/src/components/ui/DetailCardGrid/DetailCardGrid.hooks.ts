import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import {
  Children,
  isValidElement,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { GridFullRow } from './DetailCardGrid.parts';
import {
  chunkIntoRows,
  COLUMN_BREAKPOINT_SM,
  COLUMN_BREAKPOINT_XL,
  columnsForViewportWidth,
  type GridRow,
} from './DetailCardGrid.utils';

/** Estimated row height (px) before measurement. A card row's real height is
 *  its tallest card; a full-width row is a compact header/banner.
 *  `measureElement` corrects each mounted row to its real size, so this only
 *  needs to be roughly right for the common (card) case. */
const ESTIMATED_ROW_HEIGHT = 150;

/** Extra rows rendered above/below the viewport so a fast scroll never flashes blank. */
const ROW_OVERSCAN = 4;

/** Responsive column count, tracking the SAME viewport breakpoints as the
 *  grid's own Tailwind classes (`sm:`/`xl:` are viewport media queries, not
 *  container queries — see `DetailCardGrid.utils`). */
function useResponsiveColumns(): number {
  const [columns, setColumns] = useState(() => columnsForViewportWidth(window.innerWidth));

  useEffect(() => {
    const update = (): void => setColumns(columnsForViewportWidth(window.innerWidth));
    const smQuery = window.matchMedia(`(min-width: ${COLUMN_BREAKPOINT_SM}px)`);
    const xlQuery = window.matchMedia(`(min-width: ${COLUMN_BREAKPOINT_XL}px)`);
    update();
    smQuery.addEventListener('change', update);
    xlQuery.addEventListener('change', update);
    return () => {
      smQuery.removeEventListener('change', update);
      xlQuery.removeEventListener('change', update);
    };
  }, []);

  return columns;
}

/** Walk up from `start` for the nearest ancestor the browser treats as a
 *  scroll container (a genuine `overflow-y: auto|scroll`, not merely present
 *  in the DOM). Falls back to the document's own scrolling element so a grid
 *  rendered with no bounding ancestor (a bare story/test render) still
 *  resolves to something scrollable. */
function findScrollableAncestor(start: HTMLElement): HTMLElement {
  let node = start.parentElement;
  while (node !== null && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function isGridFullRow(item: ReactNode): boolean {
  return isValidElement(item) && item.type === GridFullRow;
}

/** The virtualization surface {@link DetailCardGrid} needs: a ref-setter for
 *  its root (doubling as the scroll element in "own scroll" mode), the row
 *  virtualizer, the chunked rows, and the live column count (so the JSX can
 *  render each row's cards in a matching CSS sub-grid). */
export interface DetailCardGridView {
  /** Ref for the grid's root element. */
  setRootRef: (element: HTMLDivElement | null) => void;
  /** The vertical virtualizer over the chunked rows. */
  virtualizer: Virtualizer<HTMLElement, Element>;
  /** Grid children chunked into rows (packed cards, or a single full-width item). */
  rows: GridRow[];
  /** Live responsive column count. */
  columns: number;
}

/**
 * Row-chunked virtualization for the shared results grid: only the rows near
 * the viewport (+ overscan) mount, regardless of total finding count — a
 * repo-wide Deep scan can produce hundreds. `ownScroll` selects where the
 * grid gets its scroll position from:
 *
 *  - `true` (Insight/Harness): the grid's own root is the scroll box
 *    (`overflow-y-auto`, bounded by an ancestor `flex-1 min-h-0` chain).
 *  - `false` (PR Review): the grid is embedded in an ALREADY-scrolling page,
 *    so it defers to the nearest scrollable ancestor and tracks its own
 *    offset from that ancestor's scroll origin (`scrollMargin`) — otherwise
 *    the virtualizer would think the list starts at the very top of the
 *    ancestor's scroll range instead of wherever this grid actually sits.
 */
export function useDetailCardGrid(children: ReactNode, ownScroll: boolean): DetailCardGridView {
  const columns = useResponsiveColumns();

  const rows = useMemo(
    () => chunkIntoRows(Children.toArray(children), columns, isGridFullRow),
    [children, columns],
  );

  const rootRef = useRef<HTMLElement | null>(null);
  const scrollElementRef = useRef<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  const setRootRef = useCallback(
    (element: HTMLDivElement | null) => {
      rootRef.current = element;
      scrollElementRef.current =
        element === null ? null : ownScroll ? element : findScrollableAncestor(element);
    },
    [ownScroll],
  );

  // `scrollMargin` (the grid's offset from the top of the ancestor's scroll
  // range) shifts whenever content ABOVE the grid changes height — a
  // collapsible description, a banner appearing. Re-measure on mount, on
  // viewport resize, and on every scroll tick of the ancestor (cheap, and
  // self-corrects the moment the user next scrolls past any stale value).
  // A no-op in "own scroll" mode, where the grid's root always starts flush
  // at the top of its own scroll box.
  useLayoutEffect(() => {
    if (ownScroll) {
      setScrollMargin(0);
      return;
    }
    const root = rootRef.current;
    const scrollElement = scrollElementRef.current;
    if (root === null || scrollElement === null) return;

    const measure = (): void => {
      const next =
        root.getBoundingClientRect().top -
        scrollElement.getBoundingClientRect().top +
        scrollElement.scrollTop;
      setScrollMargin((prev) => (prev === next ? prev : next));
    };
    measure();

    scrollElement.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      scrollElement.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [ownScroll, rows.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
    scrollMargin,
    // Row keys compose from their constituent items' own keys (see
    // `chunkIntoRows`) — stable across a shifted findings array, unlike an
    // index that would remap to a different row after an insert/remove.
    getItemKey: (index) => rows[index]?.key ?? index,
  });

  return { setRootRef, virtualizer, rows, columns };
}
