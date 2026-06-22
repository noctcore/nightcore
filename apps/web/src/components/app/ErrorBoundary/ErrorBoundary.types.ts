import type { ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
}

export interface ErrorBoundaryState {
  /** The caught error, or `null` while the tree is healthy. */
  error: Error | null;
}
