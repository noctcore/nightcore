import { useCallback } from 'react';

/** Returns a stable handler that reloads the webview — the boundary's recovery
 *  action. Kept here so the component file carries no logic of its own. */
export function useReload(): () => void {
  return useCallback(() => {
    if (typeof window !== 'undefined') window.location.reload();
  }, []);
}
