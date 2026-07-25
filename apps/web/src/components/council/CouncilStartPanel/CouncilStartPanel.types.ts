/** Props for the {@link import('./CouncilStartPanel').CouncilStartPanel} start form. */
import type { CouncilPresetId } from '@/lib/bridge';

export interface CouncilStartPanelProps {
  /** Convene a council over the entered objective + chosen preset (the parent mints the
   *  run id + dispatches `start_council`). Rejects when the dispatch fails so the panel
   *  keeps the typed draft and surfaces the error inline (GOV-5). */
  onStart: (objective: string, presetId: CouncilPresetId) => Promise<void>;
  /** Disable the form (e.g. no active project). */
  disabled?: boolean;
}
