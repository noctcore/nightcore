/** In-flight state for the `git init` recovery action. */
import { useCallback, useState } from 'react';

/** Track the offered `git init` so the button can spin + inert itself while the
 *  repo is initialized. Re-entry while a run is in flight is a no-op. */
export function useGitInit(onInitGit?: () => void | Promise<void>) {
  const [busy, setBusy] = useState(false);

  const runInit = useCallback(() => {
    if (onInitGit === undefined || busy) return;
    setBusy(true);
    void Promise.resolve(onInitGit()).finally(() => setBusy(false));
  }, [onInitGit, busy]);

  return { busy, runInit };
}
