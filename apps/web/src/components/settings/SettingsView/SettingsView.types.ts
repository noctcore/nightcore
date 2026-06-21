import type { Settings, SettingsPatch } from '@/lib/bridge';

/** Which scope settings edits target: the global defaults or the active project's
 *  override. The Project tab is disabled when no project is active. */
export type SettingsScope = 'global' | 'project';

export interface SettingsViewProps {
  settings: Settings;
  /** The active project id, or null when none is active (disables Project scope). */
  activeProjectId: string | null;
  activeProjectName: string | null;
  /** Apply a settings patch. The view sets `projectId` when scope is 'project'. */
  onUpdate: (patch: SettingsPatch) => void;
}
