/** A transient user-facing notification. The error tone is the primary use
 *  (surfacing `invoke` rejections that used to dead-end in `console.error`);
 *  `info`/`success` round out the palette for non-failure feedback. */
export type ToastTone = 'error' | 'info' | 'success';

export interface Toast {
  id: number;
  tone: ToastTone;
  /** Short headline (e.g. the action that failed). */
  title: string;
  /** Optional detail line (e.g. the error message). */
  description?: string;
}

/** The toast API exposed via context/hook. `error` is the convenience used by the
 *  ~25 routed `invoke`-rejection catches. */
export interface ToastApi {
  toasts: Toast[];
  /** Push a toast; returns its id so a caller can dismiss it early. */
  push: (toast: Omit<Toast, 'id'>) => number;
  /** Convenience for the common error path. `detail` accepts an unknown thrown
   *  value and is coerced to a readable string. */
  error: (title: string, detail?: unknown) => number;
  dismiss: (id: number) => void;
}
