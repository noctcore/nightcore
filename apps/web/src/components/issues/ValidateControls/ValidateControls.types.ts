/** Props for the ValidateControls — the model+effort picker and the Validate button
 *  (before/after a run), plus the live running panel + Cancel while a validation is in
 *  flight. Model/effort selection is owned upstream by the IssueTriageView hook. */
import type { IssueTriageStream } from '../issue-stream';

/** Bundled model controls to keep ValidateControlsProps under the max-props lint limit. */
export interface ModelSelectionControls {
  model: string | null;
  effort: string | null;
  providerId: string | null;
  onChangeModel: (model: string | null) => void;
  onChangeEffort: (effort: string | null) => void;
  onChangeProviderId: (providerId: string | null) => void;
}

export interface ValidateControlsProps {
  /** The active validation stream for the selected issue. */
  stream: IssueTriageStream;
  modelSelection: ModelSelectionControls;
  /** Whether a validation can be launched now (project + detail loaded, not running). */
  canValidate: boolean;
  /** True from the click through the `issue-validation-started` event (optimistic). */
  isStarting: boolean;
  /** Whether the selected issue already has a verdict — the button says "Re-validate". */
  hasVerdict: boolean;
  /** A start-command failure (e.g. a duplicate concurrent validation), or `null`. */
  startError: string | null;
  onValidate: () => void;
  onCancel: () => void;
}
