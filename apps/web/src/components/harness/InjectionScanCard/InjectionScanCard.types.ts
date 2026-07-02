/** Prop types for the injection-surface scan card. */
import type { InjectionFlag } from '@/lib/bridge';

/** Props for the injection-scan card: quarantine state comes from the policy's
 *  denyReadPaths (owned by the PolicySection parent), and quarantining a path is
 *  a policy update the parent performs. */
export interface InjectionScanCardProps {
  /** The saved `policy.denyReadPaths` — a flagged path present here is already
   *  quarantined (its row's action is disabled + relabelled). */
  denyReadPaths: string[];
  /** Append a flagged path to denyReadPaths (deduped) via the policy update. */
  onQuarantine: (path: string) => Promise<void> | void;
  /** Test/story seam: overrides the bridge scan command. Defaults to
   *  `scanInjectionSurface` (the real sweep inside Tauri). */
  scan?: () => Promise<InjectionFlag[]>;
}
