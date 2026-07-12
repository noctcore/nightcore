import {
  BranchPicker,
  Button,
  Checkbox,
  Kbd,
  Modal,
  Spinner,
  useLastPresent,
} from '@/components/ui';

import { useCreateWorktreeDialog } from './CreateWorktreeDialog.hooks';
import type { CreateWorktreeDialogProps } from './CreateWorktreeDialog.types';

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';
const LABEL_CLASS = 'font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground';

/** The "Create new worktree" dialog reached from the terminal new-tab picker (spec PR 5a):
 *  a name (slugged server-side), a "create branch" toggle, and a base-branch picker
 *  (reusing the shared `<BranchPicker>` + branch list). Built on the shared `<Modal>`
 *  (focus trap + Esc/click-outside). Purely presentational — the parent owns the create
 *  call and busy/error state; a create error shows inline and the dialog STAYS OPEN. */
export function CreateWorktreeDialog({
  open,
  branches,
  busy = false,
  error,
  onConfirm,
  onClose,
}: CreateWorktreeDialogProps) {
  const form = useCreateWorktreeDialog({ open, busy, onConfirm });
  // Retain the error across the exit animation so the panel doesn't blank on close.
  const shownError = useLastPresent(open ? { error } : null)?.error ?? error;

  return (
    <Modal
      open={open}
      label="Create worktree"
      initialFocus="#cw-name"
      panelClassName="w-full max-w-md"
      onClose={onClose}
    >
      <div className="flex flex-col gap-1 px-5 pb-3 pt-5">
        <h2 className="text-base font-semibold text-foreground">Create new worktree</h2>
        <p className="text-xs-flat text-muted-foreground">
          Branch off a base and open a shell in the new worktree. It lives under a separate{' '}
          <span className="font-mono">term/</span> namespace and is never touched by the task
          reconcile sweep.
        </p>
      </div>

      <div className="flex flex-col gap-3.5 px-5 pb-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cw-name" className={LABEL_CLASS}>
            Name
          </label>
          <input
            id="cw-name"
            value={form.name}
            onChange={(e) => form.setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                form.submit();
              }
            }}
            placeholder="e.g. spike auth refactor"
            className={INPUT_CLASS}
            disabled={busy}
          />
          {form.slug !== '' ? (
            <span className="truncate font-mono text-2xs text-muted-foreground">
              branch: term/{form.slug}
            </span>
          ) : (
            <span className="text-2xs text-muted-foreground">
              A folder-safe slug is derived from the name.
            </span>
          )}
        </div>

        <Checkbox
          checked={form.createBranch}
          onChange={form.setCreateBranch}
          label="Create a new branch"
          disabled={busy}
        />

        <div className="flex flex-col gap-1.5">
          <span className={LABEL_CLASS}>Base branch</span>
          <BranchPicker
            value={form.base}
            onChange={form.setBase}
            branches={branches}
            allowCreate={false}
            placeholder="Current branch · default"
            ariaLabel="Base branch"
            disabled={busy}
          />
        </div>
      </div>

      {shownError != null && shownError !== '' && (
        <div className="mx-5 mt-1 rounded-[8px] border border-destructive/40 bg-destructive/[0.12] px-3 py-2 text-xs-flat text-destructive">
          {shownError}
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        {busy ? (
          <span className="mr-auto flex items-center gap-1.5 text-xs-flat text-muted-foreground">
            <Spinner size={13} />
            Creating…
          </span>
        ) : (
          <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
            <Kbd>↵</Kbd> to create
          </span>
        )}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={form.submit} disabled={!form.canSubmit} aria-busy={busy}>
          Create worktree
        </Button>
      </div>
    </Modal>
  );
}
