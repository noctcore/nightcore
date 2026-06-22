import type { ReactNode } from 'react';
import { AlertIcon, CheckIcon, CloseIcon } from '../icons';
import { IconButton } from '../IconButton';
import { ToastContext, useToast, useToastState } from './Toast.hooks';
import type { ToastTone } from './Toast.types';

/** Provider + render surface for the app's transient error/notification channel
 *  (C5). Wraps the app so any descendant can `useToast()` to surface a failure
 *  the user can actually see, instead of a silent `console.error`. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const api = useToastState();
  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastStack />
    </ToastContext.Provider>
  );
}

const TONE_STYLE: Record<ToastTone, string> = {
  error: 'border-destructive/50 bg-destructive/[0.14] text-destructive',
  info: 'border-info/50 bg-info/[0.12] text-info',
  success: 'border-success/50 bg-success/[0.12] text-success',
};

function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === 'success') return <CheckIcon size={14} className="mt-0.5 shrink-0" />;
  return <AlertIcon size={14} className="mt-0.5 shrink-0" />;
}

/** The stacked toast list, pinned bottom-right above every overlay. */
function ToastStack() {
  const { toasts, dismiss } = useToast();
  if (toasts.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Notifications"
      aria-live="assertive"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className={`pointer-events-auto flex items-start gap-2 rounded-[10px] border px-3 py-2.5 shadow-2xl backdrop-blur-sm ${TONE_STYLE[toast.tone]}`}
          style={{ animation: 'nc-rise .18s cubic-bezier(.22,1,.36,1)' }}
        >
          <ToneIcon tone={toast.tone} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-foreground">{toast.title}</p>
            {toast.description !== undefined && toast.description.length > 0 && (
              <p className="mt-0.5 break-words font-mono text-[11.5px] text-muted-foreground">
                {toast.description}
              </p>
            )}
          </div>
          <IconButton label="Dismiss notification" onClick={() => dismiss(toast.id)}>
            <CloseIcon size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
