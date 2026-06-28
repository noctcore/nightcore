/** Props for the ArtifactDetailPanel sheet. */
import type { ProposedArtifactVM } from '../harness.types';

export interface ArtifactDetailPanelProps {
  /** The artifact whose detail the sheet renders. */
  artifact: ProposedArtifactVM;
  /** True while a lifecycle action is in flight — disables the footer buttons. */
  pending: boolean;
  /** Close the sheet (Esc, click-outside, or the close button). */
  onClose: () => void;
  /** Request to apply the artifact — opens the ApplyConfirmDialog upstream. */
  onApply: (artifactId: string) => void;
  /** Dismiss the proposed artifact. */
  onDismiss: (artifactId: string) => void;
  /** Restore a previously dismissed artifact. */
  onRestore: (artifactId: string) => void;
}
