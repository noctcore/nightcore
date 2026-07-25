/** Toast context, state machine hook, and the public useToast hook. */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import type { Toast, ToastApi, ToastTone } from './Toast.types';

/** How long a toast lingers before auto-dismissing (ms). Errors linger longer
 *  since they carry a message the user usually needs to read. */
const TOAST_TTL_MS = 6000;
const ERROR_TTL_MS = 10000;

/** Most toasts a user should ever see at once — older ones drop off the top. */
const MAX_VISIBLE = 4;

/** The auto-dismiss lifetime for a tone. Pure so the timing rule is unit-testable
 *  without a live provider or timers. */
export function ttlFor(tone: ToastTone): number {
  return tone === 'error' ? ERROR_TTL_MS : TOAST_TTL_MS;
}

const ToastContext = createContext<ToastApi | null>(null);

/** The provider's internal controls: the public {@link ToastApi} plus the
 *  hover-pause hooks the render surface wires to each toast (not part of the
 *  app-facing API). */
export interface ToastControls extends ToastApi {
  /** Freeze a toast's dismiss countdown while the pointer rests on it. */
  pause: (id: number) => void;
  /** Resume a paused countdown from its remaining time. */
  resume: (id: number) => void;
}

/** A live dismiss timer plus the bookkeeping needed to pause/resume it. */
interface TimerRec {
  handle: ReturnType<typeof setTimeout>;
  /** Remaining lifetime (ms) as of `startedAt`. */
  remaining: number;
  startedAt: number;
}

/** Coerce an unknown thrown value into a readable one-line message. */
export function errorMessage(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined;
  if (detail instanceof Error) return detail.message;
  if (typeof detail === 'string') return detail;
  try {
    return JSON.stringify(detail);
  } catch {
    return String(detail);
  }
}

/** The provider's internal state machine: a growing id counter, the live list,
 *  and pausable auto-dismiss timers. Exposed so `ToastProvider` stays a thin shell. */
export function useToastState(): ToastControls {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, TimerRec>>(new Map());

  const clearTimer = useCallback((id: number) => {
    const rec = timers.current.get(id);
    if (rec !== undefined) {
      clearTimeout(rec.handle);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      clearTimer(id);
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (id: number, ms: number) => {
      clearTimer(id);
      const handle = setTimeout(() => dismiss(id), ms);
      timers.current.set(id, { handle, remaining: ms, startedAt: Date.now() });
    },
    [clearTimer, dismiss],
  );

  const pause = useCallback((id: number) => {
    const rec = timers.current.get(id);
    if (rec === undefined) return;
    clearTimeout(rec.handle);
    const remaining = Math.max(0, rec.remaining - (Date.now() - rec.startedAt));
    timers.current.set(id, { ...rec, remaining });
  }, []);

  const resume = useCallback(
    (id: number) => {
      const rec = timers.current.get(id);
      if (rec !== undefined) schedule(id, rec.remaining);
    },
    [schedule],
  );

  const push = useCallback<ToastApi['push']>(
    (toast) => {
      const id = nextId.current++;
      setToasts((prev) => {
        const next = [...prev, { ...toast, id }];
        // Cap the visible stack: the oldest toasts fall off the top and their
        // timers are cleared so they don't fire against a removed entry.
        if (next.length <= MAX_VISIBLE) return next;
        const overflow = next.length - MAX_VISIBLE;
        for (const dropped of next.slice(0, overflow)) clearTimer(dropped.id);
        return next.slice(overflow);
      });
      schedule(id, ttlFor(toast.tone));
      return id;
    },
    [schedule, clearTimer],
  );

  const error = useCallback<ToastApi['error']>(
    (title, detail) => push({ tone: 'error', title, description: errorMessage(detail) }),
    [push],
  );

  return useMemo(
    () => ({ toasts, push, error, dismiss, pause, resume }),
    [toasts, push, error, dismiss, pause, resume],
  );
}

export { ToastContext };

/** Access the toast API. Throws if used outside `<ToastProvider>`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used within a ToastProvider');
  return api;
}
