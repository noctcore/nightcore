/** Toast context, state machine hook, and the public useToast hook. */
import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

import type { Toast, ToastApi } from './Toast.types';

/** How long a toast lingers before auto-dismissing (ms). */
const TOAST_TTL_MS = 6000;

const ToastContext = createContext<ToastApi | null>(null);

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
 *  and auto-dismiss timers. Exposed so `ToastProvider` stays a thin shell. */
export function useToastState(): ToastApi {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback<ToastApi['push']>(
    (toast) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { ...toast, id }]);
      const timer = setTimeout(() => dismiss(id), TOAST_TTL_MS);
      timers.current.set(id, timer);
      return id;
    },
    [dismiss],
  );

  const error = useCallback<ToastApi['error']>(
    (title, detail) => push({ tone: 'error', title, description: errorMessage(detail) }),
    [push],
  );

  return useMemo(
    () => ({ toasts, push, error, dismiss }),
    [toasts, push, error, dismiss],
  );
}

export { ToastContext };

/** Access the toast API. Throws if used outside `<ToastProvider>`. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (api === null) throw new Error('useToast must be used within a ToastProvider');
  return api;
}
