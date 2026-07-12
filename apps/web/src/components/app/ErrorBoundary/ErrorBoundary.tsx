import { Component, type ErrorInfo, type ReactNode } from 'react';

import { AlertIcon, Button, EmptyState, RetryIcon } from '@/components/ui';
import { logger } from '@/lib/logger';

import { useReload } from './ErrorBoundary.hooks';
import type { ErrorBoundaryProps, ErrorBoundaryState } from './ErrorBoundary.types';

/** The recoverable fallback shown when the boundary catches a render error. */
function ErrorFallback({ message }: { message: string }) {
  const reload = useReload();
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-foreground">
      <EmptyState
        icon={<AlertIcon size={32} />}
        title="Something went wrong"
        description={
          <>
            The interface hit an unexpected error and stopped rendering. Reloading
            usually recovers it.
            {message.length > 0 && (
              <span className="mt-2 block break-words font-mono text-xs text-destructive/80">
                {message}
              </span>
            )}
          </>
        }
        action={
          <Button onClick={reload}>
            <RetryIcon size={14} />
            Reload
          </Button>
        }
      />
    </div>
  );
}

/** Top-level React error boundary. A render/runtime throw anywhere in the
 *  tree would otherwise blank the entire WKWebView with no recovery path; this
 *  catches it, logs it, and shows a recoverable fallback with a reload action so
 *  the user is never stranded on a blank window. Class component because
 *  `getDerivedStateFromError`/`componentDidCatch` have no hook equivalent. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // A render crash's message + stacks are safe to log for diagnosis. Routed through
    // the structured web logger (#245) so UI errors are greppable and carry a single
    // seam future telemetry can hook, instead of a bare console.error.
    logger.error('ui.error-boundary', 'Unhandled UI error', {
      error: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
    });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (error !== null) return <ErrorFallback message={error.message} />;
    return this.props.children;
  }
}
