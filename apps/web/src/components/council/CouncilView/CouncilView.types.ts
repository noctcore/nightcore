/** Props for the {@link import('./CouncilView').CouncilView} surface. */
export interface CouncilViewProps {
  /** The active project's root — the working directory the seat sessions run in.
   *  `null` when no project is open (the view shows a no-project empty state). */
  projectPath: string | null;
  /** The active project's display name, for the header. */
  projectName: string | null;
}
