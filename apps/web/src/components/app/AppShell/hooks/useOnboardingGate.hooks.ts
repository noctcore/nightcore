import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'nightcore:onboarding-dismissed';

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) === 'true';
}

/** First-run onboarding visibility. The gate opens only for a brand-new registry;
 *  once skipped or completed it stays dismissed on this device. */
export function useOnboardingGate(projectCount: number) {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [forcedOpen, setForcedOpen] = useState(false);

  useEffect(() => {
    if (projectCount > 0) setDismissed(true);
  }, [projectCount]);

  const dismiss = useCallback(() => {
    setForcedOpen(false);
    setDismissed(true);
    window.localStorage.setItem(STORAGE_KEY, 'true');
  }, []);

  const restart = useCallback(() => {
    setForcedOpen(true);
    setDismissed(false);
    window.localStorage.removeItem(STORAGE_KEY);
  }, []);

  return {
    show: forcedOpen || (projectCount === 0 && !dismissed),
    dismiss,
    restart,
  };
}
