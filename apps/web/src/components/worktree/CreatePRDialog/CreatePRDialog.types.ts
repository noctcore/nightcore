/** Props for the CreatePRDialog component. */
import type { CreatePrOptions, Task } from '@/lib/bridge';

/** Props for the Create PR dialog — the human gate before anything leaves the
 *  machine. The dialog owns its editable draft (title/body/base/draft-flag,
 *  pre-filled via `draftPrMessage`) in its hooks; the parent owns the actual
 *  mutation via `onCreate` and closes the dialog by dropping `open`. */
export interface CreatePRDialogProps {
  /** Whether the dialog is mounted/visible. */
  open: boolean;
  /** The task a pull request is being created for (`null` renders nothing). */
  task: Task | null;
  /** Perform the guarded create (push + `gh pr create`). MUST reject on failure
   *  — the dialog surfaces the error inline and stays open for a retry — and
   *  resolve on success, after which the dialog closes itself via `onClose`. */
  onCreate: (id: string, opts: CreatePrOptions) => Promise<void>;
  /** Fired on Esc, click-outside, the close affordance, Cancel, and after a
   *  successful create. */
  onClose: () => void;
}
