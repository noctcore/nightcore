import {
  AlertIcon,
  BranchIcon,
  Button,
  CloseIcon,
  IconButton,
  Modal,
  RefreshIcon,
  Spinner,
  useLastPresent,
} from '@/components/ui';

import {
  isBehindBase,
  isMergeBlocked,
  mergeStatusBanner,
  showsCheckoutNote,
  staleBranchHazard,
} from './MergePreviewDialog.hooks';
import type { MergePreviewDialogProps } from './MergePreviewDialog.types';

/** A read-only preview of merging a worktree branch into its base BEFORE the user
 *  commits to the merge (modeled on Aperant's merge-preview): a status banner, the
 *  branch → base target, a changed-file/ahead-behind stats row, and — when the
 *  merge would conflict — the conflicting files plus resolve guidance.
 *
 *  When the branch is BEHIND base it also raises a stale-branch hazard callout and
 *  offers "Update from base" — a stale branch (cut before a base-only commit) can
 *  silently revert that commit on merge, the documented silent-revert incident.
 *
 *  Built on the shared `<Modal>` primitive, so it gets the focus trap + Esc /
 *  click-outside close for free. Cmd/Ctrl+Enter confirms the merge when it is
 *  mergeable (bare Enter never does — the house dialog rule guards this destructive
 *  action). Purely presentational: the parent computes the preview and owns the
 *  actions. */
export function MergePreviewDialog({
  open,
  preview,
  loading = false,
  merging = false,
  terminalSessions = 0,
  updatingFromBase = false,
  onMerge,
  onUpdateFromBase,
  onClose,
  onViewDiff,
}: MergePreviewDialogProps) {
  // Retain the preview across the exit animation so the body doesn't blank when
  // the parent clears it on close. `loading`/`merging`/callbacks stay live.
  const shownPreview = useLastPresent(preview);
  const mergeDisabled = isMergeBlocked(shownPreview, loading, merging);
  const banner = shownPreview !== null ? mergeStatusBanner(shownPreview) : null;
  // Pure derivations (no hooks) — safe to compute inline in the body.
  const hazard = staleBranchHazard(shownPreview);
  const behind = isBehindBase(shownPreview);
  const showCheckoutNote = showsCheckoutNote(shownPreview, loading);

  return (
    <Modal
      open={open}
      label="Merge preview"
      panelClassName="w-full max-w-md"
      onClose={onClose}
      onEnter={mergeDisabled ? undefined : onMerge}
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">Merge preview</h2>
          {shownPreview !== null && (
            <div className="flex items-center gap-1.5 text-xs-plus2 text-muted-foreground">
              <BranchIcon size={13} />
              <span className="truncate font-mono text-foreground">{shownPreview.branch}</span>
              <span aria-hidden>→</span>
              <span className="truncate font-mono text-foreground">{shownPreview.base}</span>
            </div>
          )}
        </div>
        <IconButton label="Close" onClick={onClose} className="-mr-1 shrink-0">
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex flex-col gap-3 px-5 pb-2">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-xs-plus2 text-muted-foreground">
            <Spinner />
            <span>Checking for conflicts…</span>
          </div>
        ) : shownPreview === null || banner === null ? (
          <p className="py-2 text-xs-plus2 text-muted-foreground">No preview available.</p>
        ) : (
          <>
            <div
              className={`flex items-center gap-2 rounded-nc border px-3 py-2 text-xs-plus2 font-semibold ${banner.className}`}
            >
              <banner.Icon size={14} />
              <span>{banner.label}</span>
            </div>

            <p className="text-xs-flat text-muted-foreground">
              {shownPreview.files.length} files,{' '}
              <span className="text-success">+{shownPreview.additions}</span>{' '}
              <span className="text-destructive">−{shownPreview.deletions}</span>,{' '}
              {shownPreview.ahead} ahead / {shownPreview.behind} behind
            </p>

            {hazard !== null && (
              <div className="flex items-start gap-2 rounded-nc border border-warning/40 bg-warning/[0.12] px-3 py-2 text-xs-flat leading-snug text-warning">
                <AlertIcon size={14} className="mt-0.5 shrink-0" />
                <span>{hazard}</span>
              </div>
            )}

            {terminalSessions > 0 && (
              <p className="flex items-center gap-1.5 text-xs-flat font-medium text-warning">
                <AlertIcon size={13} className="shrink-0" />
                {terminalSessions} terminal session(s) open in this worktree will be closed.
              </p>
            )}

            {shownPreview.status === 'conflicts' && (
              <div className="flex flex-col gap-1.5">
                <ul className="flex flex-col gap-0.5 rounded-nc border border-destructive/30 bg-destructive/[0.08] px-3 py-2">
                  {shownPreview.conflictFiles.map((path) => (
                    <li key={path} className="truncate font-mono text-xs-flat text-destructive">
                      {path}
                    </li>
                  ))}
                </ul>
                <p className="text-xs-flat leading-snug text-muted-foreground">
                  Resolve these files in the worktree, commit, then merge again.
                </p>
              </div>
            )}

            {showCheckoutNote && (
              // Distinct from the amber hazard: a quiet heads-up that `merge_branch`
              // does a `git checkout <base>` in the project root and leaves HEAD
              // there. The base is interpolated as plain text (not its own span) so
              // it doesn't create a second element whose exact text is the base name.
              <p className="text-xs-flat text-muted-foreground">
                Merging checks out {shownPreview.base} in the main repo and leaves it there.
              </p>
            )}
          </>
        )}
      </div>

      <div className="mt-2 flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        {onViewDiff !== undefined && (
          <button
            type="button"
            onClick={onViewDiff}
            className="mr-auto text-xs-flat text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            View full diff
          </button>
        )}
        {behind && (
          <Button variant="ghost" disabled={updatingFromBase} onClick={onUpdateFromBase}>
            {updatingFromBase ? (
              <>
                <Spinner />
                <span>Updating…</span>
              </>
            ) : (
              <>
                <RefreshIcon size={14} />
                <span>Update from base</span>
              </>
            )}
          </Button>
        )}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={mergeDisabled} onClick={onMerge}>
          {merging ? (
            <>
              <Spinner />
              <span>Merging…</span>
            </>
          ) : (
            'Merge'
          )}
        </Button>
      </div>
    </Modal>
  );
}
