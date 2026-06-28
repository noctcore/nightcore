import type { ReactNode } from 'react';

/** Props for the {@link ErrorBoundary}: the subtree it guards. */
export interface ErrorBoundaryProps {
  children: ReactNode;
}

/** Internal state for the {@link ErrorBoundary}. */
export interface ErrorBoundaryState {
  /** The caught error, or `null` while the tree is healthy. */
  error: Error | null;
}
