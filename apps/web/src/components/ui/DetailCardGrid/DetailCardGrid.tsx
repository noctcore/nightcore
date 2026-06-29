/** The shared responsive card grid for finding/convention results, with an
 *  empty state and streaming skeleton placeholders. Each feature maps its items
 *  to {@link DetailCard}s and passes them as `children`; the grid owns the
 *  layout, the empty message, and the in-flight skeletons. */
import { Skeleton } from '../Skeleton';
import type { DetailCardGridProps } from './DetailCardGrid.types';

/** A skeleton card that preserves the card layout while a pass is still running
 *  (streaming UX). */
function SkeletonCard() {
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-border bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-14" />
        <Skeleton className="h-4 w-16" />
        <Skeleton className="ml-auto h-4 w-10" />
      </div>
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/3" />
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-5/6" />
    </div>
  );
}

/** Renders the card children, then any streaming skeletons; falls back to a
 *  centered empty message when there is nothing to show and nothing in flight. */
export function DetailCardGrid({
  isEmpty,
  emptyMessage,
  skeletonCount,
  children,
}: DetailCardGridProps) {
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
      aria-busy={skeletonCount > 0 || undefined}
      className="grid flex-1 grid-cols-1 content-start gap-3 overflow-y-auto px-6 py-5 sm:grid-cols-2 xl:grid-cols-3"
    >
      {children}
      {Array.from({ length: skeletonCount }).map((_, i) => (
        <SkeletonCard key={`skeleton-${i}`} />
      ))}
    </div>
  );
}
