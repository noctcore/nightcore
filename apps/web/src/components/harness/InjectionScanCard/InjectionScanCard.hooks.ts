/** Scan + quarantine state for the injection-surface card. */
import { useCallback, useState } from 'react';
import { scanInjectionSurface, type InjectionFlag } from '@/lib/bridge';
import type { InjectionScanCardProps } from './InjectionScanCard.types';

/** Everything the InjectionScanCard shell renders. */
export interface InjectionScanVM {
  /** The last scan's flags, or `null` before any scan has run. */
  flags: InjectionFlag[] | null;
  scanning: boolean;
  scanError: string | null;
  runScan: () => void;
  /** The path whose quarantine write is in flight, or `null`. */
  quarantiningPath: string | null;
  quarantine: (path: string) => void;
  /** Whether a flagged path is already in the saved denyReadPaths. */
  isQuarantined: (path: string) => boolean;
}

/** Own the scan lifecycle (run / results / error) and the per-row quarantine
 *  dispatch. Quarantine itself is the parent's policy update — its result lands
 *  back here through the `denyReadPaths` prop, flipping the row's state. */
export function useInjectionScan({
  denyReadPaths,
  onQuarantine,
  scan,
}: InjectionScanCardProps): InjectionScanVM {
  const [flags, setFlags] = useState<InjectionFlag[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [quarantiningPath, setQuarantiningPath] = useState<string | null>(null);

  const runScan = useCallback(() => {
    if (scanning) return;
    setScanning(true);
    setScanError(null);
    void (async () => {
      try {
        const next = await (scan ?? scanInjectionSurface)();
        setFlags(next);
      } catch (err) {
        setScanError(err instanceof Error ? err.message : String(err));
      } finally {
        setScanning(false);
      }
    })();
  }, [scanning, scan]);

  const quarantine = useCallback(
    (path: string) => {
      if (quarantiningPath !== null) return;
      setQuarantiningPath(path);
      void (async () => {
        try {
          // Failures surface via the parent's toast (it owns the write); this
          // catch only guarantees the row's pending state always clears.
          await onQuarantine(path);
        } finally {
          setQuarantiningPath(null);
        }
      })();
    },
    [quarantiningPath, onQuarantine],
  );

  const isQuarantined = useCallback(
    (path: string) => denyReadPaths.includes(path),
    [denyReadPaths],
  );

  return {
    flags,
    scanning,
    scanError,
    runScan,
    quarantiningPath,
    quarantine,
    isQuarantined,
  };
}
