import { useEffect, useRef } from 'react';

/** Trailing-debounce window (ms) for the app-window focus trigger. An alt-tab storm
 *  (many rapid `focus` / `visibilitychange` events) collapses to a single poll — the
 *  focus poll is a courtesy refresh, never a per-event fetch. */
const FOCUS_POLL_DEBOUNCE_MS = 1000;

/** GitHub two-way sync (#97 PR 4, §4) — the FIRST app-level window-focus listener in the
 *  tree (only component-local `focus` handlers existed before). Runs `onFocus` a debounced
 *  ~1s after the app window regains focus, wiring the DOM `window 'focus'` +
 *  `document 'visibilitychange'(visible)` signals (both fire reliably in a WKWebView, so no
 *  new Tauri capability is needed). Used to re-run the intake issue-list loader (Issues
 *  view) and the upstream-state projection poll.
 *
 *  The callback is read through a ref, so passing a fresh closure each render never
 *  re-subscribes the listeners; `enabled` (default true) fully gates the subscription —
 *  when false, nothing is registered. Every listener + the pending timer are torn down on
 *  unmount / gate-off. */
export function useWindowFocusPoll(onFocus: () => void, enabled = true): void {
  const callback = useRef(onFocus);
  callback.current = onFocus;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const trigger = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        callback.current();
      }, FOCUS_POLL_DEBOUNCE_MS);
    };
    // `visibilitychange` also fires on tab-hide; only a transition BACK to visible is a
    // "regained focus" signal worth polling on.
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') trigger();
    };
    window.addEventListener('focus', trigger);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', trigger);
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [enabled]);
}
