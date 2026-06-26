import { useEffect } from 'react';
import type { ToastApi } from '@/components/ui';

/** Last-resort UI net for stray promise rejections that escape component-level
 *  handling — fire-and-forget `void someAsync()` handlers, event-callback throws —
 *  and would otherwise dead-end in the console with no user-visible recovery. The
 *  React `ErrorBoundary` only catches *render* throws; this is its async sibling,
 *  mirroring the sidecar's process-level `unhandledRejection` guard so nothing
 *  fails silently. Mounted for the app's lifetime (AppShell never unmounts) and
 *  wired to the same toast channel every routed `invoke` catch already uses.
 *
 *  Depends on the stable `toast.error` reference (not the whole `toast` object,
 *  whose identity changes on every toast push) so the window listener registers
 *  once instead of churning on each notification. */
export function useGlobalErrorToast(toast: ToastApi): void {
  const { error } = toast;
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      // Don't `preventDefault()`: keep the default console diagnostic and just add
      // a visible surface on top of it.
      console.error('unhandled promise rejection', event.reason);
      // Generic headline (the global net has no surface context) but the real
      // reason rides in the toast's description line. Distinct from the
      // ErrorBoundary's render-crash copy so the two nets aren't confused.
      error('Unexpected error', event.reason);
    };
    window.addEventListener('unhandledrejection', onRejection);
    return () => window.removeEventListener('unhandledrejection', onRejection);
  }, [error]);
}
