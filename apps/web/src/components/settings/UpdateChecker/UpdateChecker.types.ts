/** Props and state types for the in-app updater control. */

export type UpdateCheckerStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'installing'
  | 'up-to-date'
  | 'error'
  | 'deferred';

/** Props for the Settings → About update checker. */
export interface UpdateCheckerProps {
  /** When false, installs are blocked until active runs finish. */
  isAppIdle: boolean;
  /** Run a background check once after mount (30s delay). */
  checkOnStartup?: boolean;
}