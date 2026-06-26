export interface InsightViewProps {
  /** The active project's absolute path (null when no project is active). */
  projectPath: string | null;
  /** The active project's display name. */
  projectName: string | null;
  /** Navigate to the board (used after convert-to-task). */
  onGotoBoard?: () => void;
}
