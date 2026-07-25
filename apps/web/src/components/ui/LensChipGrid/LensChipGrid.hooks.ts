/** State for the shared scan CONFIGURE form. */
import { useEffect, useState } from 'react';

import type { ScanLimits } from '@/lib/bridge';
import { previewScanLimits } from '@/lib/bridge';

/**
 * The ceilings a scan would run under with `passCount` lenses selected (#401).
 *
 * Re-resolved whenever the selection changes, because the per-pass budget is the
 * Settings ceiling DIVIDED by the pass count — selecting more categories lowers what
 * each one gets. Rust owns that arithmetic; this only fetches the result.
 *
 * Advisory: a failed or outside-Tauri read resolves to uncapped (`{}`), which renders
 * nothing rather than blocking the screen. Stale replies are ignored so a fast toggle
 * can't leave an older count's numbers on screen.
 */
export function useScanLimits(passCount: number): ScanLimits {
  const [limits, setLimits] = useState<ScanLimits>({});

  useEffect(() => {
    let active = true;
    void previewScanLimits(passCount).then((next) => {
      if (active) setLimits(next);
    });
    return () => {
      active = false;
    };
  }, [passCount]);

  return limits;
}
