/** Root component: error boundary + motion + toast providers wrapping the shell. */
import { AppShell, ErrorBoundary } from '@/components/app';
import { MotionProvider, ToastProvider } from '@/components/ui';

/** The app host: a top-level error boundary (so a render throw never blanks the
 *  whole webview) wraps the motion provider (LazyMotion + reduced-motion config,
 *  mounted high so its internals never re-render on a stream flush and the feature
 *  bundle loads once), the toast provider (the user-facing error channel), and the
 *  shell, which owns routing, the project switcher, and every view. */
export function App() {
  return (
    <ErrorBoundary>
      <MotionProvider>
        <ToastProvider>
          <AppShell />
        </ToastProvider>
      </MotionProvider>
    </ErrorBoundary>
  );
}
