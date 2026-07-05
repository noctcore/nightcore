/** Props for the ArtifactDetailPanel sheet. */
import type { ProposedArtifactVM } from '../harness.types';

export interface ArtifactDetailPanelProps {
  /** Presence flag — the sheet animates in/out. Keep it always-mounted and toggle
   *  `open` instead of `{cond && <ArtifactDetailPanel/>}`. */
  open: boolean;
  /** The artifact whose detail the sheet renders (or `null` while closed — the
   *  last one is retained across the exit animation). */
  artifact: ProposedArtifactVM | null;
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
  /** Request to arm an APPLIED eslint-class artifact as a Structure-Lock gauntlet check
   *  — opens the arm-confirm dialog upstream. Absent ⇒ no arm affordance. */
  onArm?: (artifactId: string) => void;
}
