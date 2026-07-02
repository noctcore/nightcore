import { useEffect, useState } from 'react';

import { isTauri } from '@/lib/bridge';

/** How long the boot splash stays up on first mount (ms). */
const SPLASH_DURATION_MS = 1400;

/** A brief boot splash on first mount, per the design. Skipped outside Tauri so
 *  Storybook/dev renders the shell immediately. */
export function useSplash(): boolean {
  const [showSplash, setShowSplash] = useState(isTauri());
  useEffect(() => {
    if (!showSplash) return;
    const timer = setTimeout(() => setShowSplash(false), SPLASH_DURATION_MS);
    return () => clearTimeout(timer);
  }, [showSplash]);
  return showSplash;
}
