/** The shared responsive card grid for finding/convention results, with an
 *  empty state and streaming skeleton placeholders. Each feature maps its
 *  items to {@link DetailCard}s and passes them as `children`; the grid owns
 *  the layout, the empty message, and the in-flight skeletons.
 *
 *  Row-chunked virtualization (`@tanstack/react-virtual`): only the rows near
 *  the viewport (+ overscan) mount, regardless of total item count — a
 *  repo-wide Deep scan can produce hundreds of findings. Cards pack
 *  `columns`-per-row (matching the responsive `sm:`/`xl:` breakpoints below);
 *  an item wrapped in {@link GridFullRow} gets its own full-width row. */
import { useDetailCardGrid } from './DetailCardGrid.hooks';
import { SkeletonCard } from './DetailCardGrid.parts';
import type { DetailCardGridProps } from './DetailCardGrid.types';

export { GridFullRow } from './DetailCardGrid.parts';

/** Renders the card children as virtualized rows, then any streaming
 *  skeletons; falls back to a centered empty message when there is nothing
 *  to show and nothing in flight. */
export function DetailCardGrid({
  isEmpty,
  emptyMessage,
  skeletonCount,
  children,
  scrollsWithPage = false,
}: DetailCardGridProps) {
  const { setRootRef, virtualizer, rows, columns } = useDetailCardGrid(
    children,
    !scrollsWithPage,
  );

  if (isEmpty) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={setRootRef}
      aria-busy={skeletonCount > 0 || undefined}
      className={`flex-1 px-6 py-5 ${scrollsWithPage ? '' : 'overflow-y-auto'}`}
    >
      <div style={{ position: 'relative', width: '100%', height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const row = rows[virtualRow.index];
          if (row === undefined) return null;
          return (
            <div
              key={row.key}
              data-index={virtualRow.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full pb-3"
              style={{
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {row.fullWidth ? (
                row.items[0]
              ) : (
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                  {row.items}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {skeletonCount > 0 && (
        <div
          className="grid gap-3"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: skeletonCount }).map((_, i) => (
            <SkeletonCard key={`skeleton-${i}`} />
          ))}
        </div>
      )}
    </div>
  );
}
