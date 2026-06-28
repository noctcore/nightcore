/** Root component: error boundary + toast provider wrapping the app shell. */
import { AppShell, ErrorBoundary } from '@/components/app';
import { ToastProvider } from '@/components/ui';

/** The app host: a top-level error boundary (so a render throw never blanks the
 *  whole webview) wraps the toast provider (the user-facing error channel) and
 *  the shell, which owns routing, the project switcher, and every view. */
export function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </ErrorBoundary>
  );
}
