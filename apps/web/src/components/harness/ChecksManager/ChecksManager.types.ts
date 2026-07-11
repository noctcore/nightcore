/** Types for the Checks Manager — the armed-checks panel on the Enforce stage. */
import type { ArmedCheck, ArmedChecksLastRun } from '@/lib/bridge';

/** The in-progress edit of one armed check. `timeoutMs` is the raw input string
 *  (parsed to a number on save; blank ⇒ the runner default). */
export interface ChecksEditDraft {
  /** The name that identifies the check being edited (its merge key on save). */
  originalName: string;
  name: string;
  kind: string;
  command: string;
  timeoutMs: string;
  enabled: boolean;
}

/** The run-now slice of the view model. */
export interface ChecksRunVM {
  running: boolean;
  error: string | null;
  start: () => void;
}

/** The edit slice of the view model. `draft` is non-null only while a row is open. */
export interface ChecksEditVM {
  draft: ChecksEditDraft | null;
  saving: boolean;
  error: string | null;
  start: (check: ArmedCheck) => void;
  change: (patch: Partial<ChecksEditDraft>) => void;
  cancel: () => void;
  save: () => void;
}

/** The remove-confirm slice of the view model. */
export interface ChecksRemoveVM {
  target: ArmedCheck | null;
  busy: boolean;
  request: (check: ArmedCheck) => void;
  cancel: () => void;
  confirm: () => void;
}

/** The whole Checks Manager view model, grouped so the panel renders purely from it. */
export interface ChecksManagerVM {
  loading: boolean;
  loadError: string | null;
  checks: ArmedCheck[];
  lastRun: ArmedChecksLastRun | null;
  /** A toggle/remove error surfaced above the list. */
  actionError: string | null;
  /** The check with an in-flight enable/disable toggle, if any. */
  pendingName: string | null;
  run: ChecksRunVM;
  toggle: (name: string, enabled: boolean) => void;
  edit: ChecksEditVM;
  remove: ChecksRemoveVM;
}

/** Props for {@link ChecksManager}. It owns its data via `useChecksManager`, so the
 *  only prop is an optional test/story seam to inject a view model. */
export interface ChecksManagerProps {
  /** Injected view model (Storybook / tests). Omitted in the app — the component
   *  builds its own via `useChecksManager`. */
  vm?: ChecksManagerVM;
}
