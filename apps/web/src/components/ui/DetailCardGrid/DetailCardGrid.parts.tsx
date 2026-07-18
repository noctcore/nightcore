/** Presentational pieces for {@link DetailCardGrid}: the streaming skeleton
 *  card and the full-row marker. */
import type { ReactNode } from 'react';

import { Skeleton } from '../Skeleton';

/** The centered empty-state message shared by every card/row grid (the finding,
 *  convention, dimension, and proposal lists all render the identical block when
 *  they have nothing to show and nothing in flight). */
export function GridEmptyMessage({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <p className="max-w-md text-center text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

/** A skeleton card that preserves the card layout while a pass is still running
 *  (streaming UX). */
export function SkeletonCard() {
  return (
    <div className="flex flex-col gap-2 rounded-nc border border-border bg-white/[0.02] p-3.5">
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

/** Marks a grid child as a full-width row (spanning every column) instead of
 *  a packed card — e.g. PR Review's severity-group headers and summary/
 *  quick-select banners, interleaved with cards in the same flat children
 *  list. Purely a type-identity marker: the row-chunker (`DetailCardGrid.utils`)
 *  checks `child.type === GridFullRow` and gives the wrapped content its own
 *  dedicated row rather than packing it beside cards. */
export function GridFullRow({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
