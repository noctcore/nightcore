/** Props for the PortableLockExportButton — the self-contained "Export portable
 *  lock" trigger the Enforce results bar drops in beside `IssueMapExportButton`. It
 *  owns its dialog open-state + the export action (in its hooks), so the results view
 *  adds no state or hook-return surface of its own. */
export interface PortableLockExportButtonProps {
  /** The active project's absolute path — the export root. `null` (no active
   *  project) renders the trigger disabled. */
  projectPath: string | null;
}
