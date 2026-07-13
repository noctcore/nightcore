/** Props for the {@link import('./CouncilStartPanel').CouncilStartPanel} start form. */
export interface CouncilStartPanelProps {
  /** Convene a council over the entered objective (the parent mints the run id +
   *  dispatches `start_council`). */
  onStart: (objective: string) => void;
  /** Disable the form (e.g. no active project). */
  disabled?: boolean;
}
