/** Prop types for the top-level HarnessView component. */

/** Props for the HarnessView shell: the active project's path and display name. */
export interface HarnessViewProps {
  /** The active project's absolute path (null when no project is active). */
  projectPath: string | null;
  /** The active project's display name. */
  projectName: string | null;
}
