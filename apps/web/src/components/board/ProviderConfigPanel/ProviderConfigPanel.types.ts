/** Prop and data-seam types for the ProviderConfigPanel component. */
import type { ProviderConfigSnapshot } from '@/lib/bridge';

/** The injectable data seam — defaults to the real bridge in the live hook, but
 *  stories/tests pass an in-memory loader so the panel renders without Tauri. */
export interface ProviderConfigData {
  load: (projectPath?: string) => Promise<ProviderConfigSnapshot>;
}

/** Props for `ProviderConfigPanel`. */
export interface ProviderConfigPanelProps {
  /** The project the inspector reads against. `path` resolves the snapshot;
   *  `name` titles the panel. */
  projectPath: string;
  projectName: string;
  /** Close the panel (Esc, click-outside, and the close affordance route here). */
  onClose: () => void;
  /** Override the data seam (stories/tests). Defaults to the live bridge. */
  data?: ProviderConfigData;
}
