import {
  BranchIcon,
  Button,
  Checkbox,
  FolderIcon,
  LockIcon,
  Modal,
  SearchIcon,
  Spinner,
  useLastPresent,
} from '@/components/ui';

import { hasPickerError, hasTargets } from './NewTabPicker.hooks';
import type { NewTabPickerProps, TerminalTarget } from './NewTabPicker.types';

function TargetRow({
  target,
  disabled,
  onPick,
}: {
  target: TerminalTarget;
  disabled: boolean;
  onPick: (path: string) => void;
}) {
  const Icon = target.kind === 'repo' ? FolderIcon : BranchIcon;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(target.path)}
      className="flex w-full items-center gap-2.5 rounded-[9px] border border-border/70 bg-black/10 px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Icon size={15} className="shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[13px] font-medium text-foreground">{target.label}</span>
        {target.detail !== undefined && (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {target.detail}
          </span>
        )}
      </span>
    </button>
  );
}

/** The new-terminal picker: choose the repo root or a worktree to open a shell in.
 *  Built on the shared `<Modal>` primitive (focus trap + Esc/click-outside close).
 *  Purely presentational — the parent owns the target list, the spawn, and the
 *  busy/error state. A spawn error (e.g. the 8-session cap) is shown inline and
 *  the picker STAYS OPEN so the user sees why nothing opened. */
export function NewTabPicker({
  open,
  targets,
  onPick,
  onBrowse,
  onClose,
  error,
  busy = false,
  confinedAvailable,
  confined,
  onConfinedChange,
}: NewTabPickerProps) {
  // Retain content across the exit animation so the panel doesn't blank when the
  // parent clears its state on close. Callbacks stay live.
  const shown =
    useLastPresent(open ? { targets, error } : null) ?? { targets, error };

  return (
    <Modal
      open={open}
      label="Open a terminal"
      panelClassName="w-full max-w-md overflow-hidden rounded-[14px] border border-border bg-popover shadow-2xl"
      onClose={onClose}
    >
      <div className="flex flex-col gap-1 px-5 pb-3 pt-5">
        <h2 className="text-base font-semibold text-foreground">Open a terminal</h2>
        <p className="text-[12px] text-muted-foreground">
          Your shell runs with full permissions, outside the agent guardrails.
        </p>
      </div>

      <div className="flex max-h-[50vh] flex-col gap-1.5 overflow-y-auto px-5 pb-2">
        {hasTargets(shown.targets) ? (
          shown.targets.map((target) => (
            <TargetRow
              key={`${target.kind}:${target.path}`}
              target={target}
              disabled={busy}
              onPick={onPick}
            />
          ))
        ) : (
          <p className="py-3 text-[13px] text-muted-foreground">
            No open project — browse for a folder to start a terminal.
          </p>
        )}

        {/* Browse ANY directory — opens the folder browser. The confined choice
            below carries into the browsed spawn. */}
        <button
          type="button"
          disabled={busy}
          onClick={onBrowse}
          className="flex w-full items-center gap-2.5 rounded-[9px] border border-dashed border-border/70 bg-transparent px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-accent/40 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <SearchIcon size={15} className="shrink-0 text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[13px] font-medium text-foreground">Browse…</span>
            <span className="truncate text-[11px] text-muted-foreground">
              Open a shell in any folder on your machine
            </span>
          </span>
        </button>
      </div>

      {confinedAvailable && (
        <div className="mx-5 mt-1 flex items-start gap-2 rounded-[9px] border border-border/60 bg-black/10 px-3 py-2.5">
          <LockIcon size={14} className="mt-[3px] shrink-0 text-warning/80" aria-hidden />
          <div className="flex min-w-0 flex-col gap-0.5">
            <Checkbox
              checked={confined}
              onChange={onConfinedChange}
              label="Confined (writes limited to this folder)"
              disabled={busy}
            />
            <span className="text-[11px] text-muted-foreground">
              Runs the shell inside the macOS write-containment sandbox, scoped to the
              chosen folder. Off by default — your shell is otherwise unconfined.
            </span>
          </div>
        </div>
      )}

      {hasPickerError(shown.error) && (
        <div className="mx-5 mt-1 rounded-[8px] border border-destructive/40 bg-destructive/[0.12] px-3 py-2 text-[12px] text-destructive">
          {shown.error}
        </div>
      )}

      <div className="mt-2 flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        {busy && (
          <span className="mr-auto flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Spinner size={13} />
            Opening…
          </span>
        )}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
