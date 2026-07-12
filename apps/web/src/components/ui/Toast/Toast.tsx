/** Toast provider and render surface for transient notifications. */
import type { ReactNode } from 'react';

import { IconButton } from '../IconButton';
import { AlertIcon, CheckIcon, CloseIcon } from '../icons';
import { AnimatePresence, m, slideIn } from '../motion';
import { ToastContext, useToast, useToastState } from './Toast.hooks';
import type { ToastTone } from './Toast.types';

/** Provider + render surface for the app's transient error/notification channel.
 *  Wraps the app so any descendant can `useToast()` to surface a failure the user
 *  can actually see, instead of a silent `console.error`. */
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

/** Leading icon for a toast: a check for success, an alert otherwise. */
function ToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === 'success') return <CheckIcon size={14} className="mt-0.5 shrink-0" />;
  return <AlertIcon size={14} className="mt-0.5 shrink-0" />;
}

/** The stacked toast list, pinned bottom-right above every overlay. Each toast
 *  slides in from the right and reverses on dismiss via `AnimatePresence` (the
 *  `slideIn` variant — transform + opacity only, no `layout`, so the stack reflows
 *  instantly). The region stays mounted even when empty so `AnimatePresence` can
 *  still run the LAST toast's exit animation. */
function ToastStack() {
  const { toasts, dismiss } = useToast();
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
    >
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <m.div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            variants={slideIn}
            initial="initial"
            animate="animate"
            exit="exit"
            className={`pointer-events-auto flex items-start gap-2 rounded-[10px] border px-3 py-2.5 shadow-2xl backdrop-blur-sm ${TONE_STYLE[toast.tone]}`}
          >
            <ToneIcon tone={toast.tone} />
            <div className="min-w-0 flex-1">
              <p className="text-xs-plus2 font-semibold text-foreground">{toast.title}</p>
              {toast.description !== undefined && toast.description.length > 0 && (
                <p className="mt-0.5 break-words font-mono text-2xs-plus text-muted-foreground">
                  {toast.description}
                </p>
              )}
            </div>
            <IconButton label="Dismiss notification" onClick={() => dismiss(toast.id)}>
              <CloseIcon size={14} />
            </IconButton>
          </m.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
