/** Scope, page, and props types for the Settings view. */
import type { Settings, SettingsPatch } from '@/lib/bridge';

/** Which scope settings edits target: the global defaults or the active project's
 *  override. The Project tab is disabled when no project is active. */
export type SettingsScope = 'global' | 'project';

/** The settings pages reachable from the left nav. */
export type SettingsPage =
  | 'models'
  | 'permissions'
  | 'constitution'
  | 'worktrees'
  | 'interface'
  | 'providers'
  | 'hooks'
  | 'paths'
  | 'about';

/** Props for the Settings view. */
export interface SettingsViewProps {
  settings: Settings;
  /** The active project id, or null when none is active (disables Project scope). */
  activeProjectId: string | null;
  activeProjectName: string | null;
  /** The active project's path, shown on the Paths page. */
  activeProjectPath?: string | null;
  /** Apply a settings patch. The view sets `projectId` when scope is 'project'. */
  onUpdate: (patch: SettingsPatch) => void;
  /** Reopen the first-run setup flow from the About page. */
  onRestartOnboarding: () => void;
}
