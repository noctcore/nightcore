import { BranchIcon, Button, CloseIcon, IconButton, Modal, Spinner } from '@/components/ui';
import { isMergeBlocked, mergeStatusBanner } from './MergePreviewDialog.hooks';
import type { MergePreviewDialogProps } from './MergePreviewDialog.types';

/** A read-only preview of merging a worktree branch into its base BEFORE the user
 *  commits to the merge (modeled on Aperant's merge-preview): a status banner, the
 *  branch → base target, a changed-file/ahead-behind stats row, and — when the
 *  merge would conflict — the conflicting files plus resolve guidance.
 *
 *  Built on the shared `<Modal>` primitive, so it gets the focus trap + Esc /
 *  click-outside close for free. Enter confirms the merge when it is mergeable.
 *  Purely presentational: the preview is computed by the parent. */
export function MergePreviewDialog({
  open,
  preview,
  loading = false,
  merging = false,
  onMerge,
  onClose,
  onViewDiff,
}: MergePreviewDialogProps) {
  if (!open) return null;

  const mergeDisabled = isMergeBlocked(preview, loading, merging);
  const banner = preview !== null ? mergeStatusBanner(preview) : null;

  return (
    <Modal
      label="Merge preview"
      panelClassName="w-full max-w-md overflow-hidden rounded-[14px] border border-border bg-popover shadow-2xl"
      onClose={onClose}
      onEnter={mergeDisabled ? undefined : onMerge}
    >
      <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-5">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-base font-semibold text-foreground">Merge preview</h2>
          {preview !== null && (
            <div className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <BranchIcon size={13} />
              <span className="truncate font-mono text-foreground">{preview.branch}</span>
              <span aria-hidden>→</span>
              <span className="truncate font-mono text-foreground">{preview.base}</span>
            </div>
          )}
        </div>
        <IconButton label="Close" onClick={onClose} className="-mr-1 shrink-0">
          <CloseIcon size={16} />
        </IconButton>
      </div>

      <div className="flex flex-col gap-3 px-5 pb-2">
        {loading ? (
          <div className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground">
            <Spinner />
            <span>Checking for conflicts…</span>
          </div>
        ) : preview === null || banner === null ? (
          <p className="py-2 text-[13px] text-muted-foreground">No preview available.</p>
        ) : (
          <>
            <div
              className={`flex items-center gap-2 rounded-[10px] border px-3 py-2 text-[13px] font-semibold ${banner.className}`}
            >
              <banner.Icon size={14} />
              <span>{banner.label}</span>
            </div>

            <p className="text-[12px] text-muted-foreground">
              {preview.files.length} files,{' '}
              <span className="text-success">+{preview.additions}</span>{' '}
              <span className="text-destructive">−{preview.deletions}</span>,{' '}
              {preview.ahead} ahead / {preview.behind} behind
            </p>

            {preview.status === 'conflicts' && (
              <div className="flex flex-col gap-1.5">
                <ul className="flex flex-col gap-0.5 rounded-[10px] border border-destructive/30 bg-destructive/[0.08] px-3 py-2">
                  {preview.conflictFiles.map((path) => (
                    <li key={path} className="truncate font-mono text-[12px] text-destructive">
                      {path}
                    </li>
                  ))}
                </ul>
                <p className="text-[12px] leading-snug text-muted-foreground">
                  Resolve these files in the worktree, commit, then merge again.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      <div className="mt-2 flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        {onViewDiff !== undefined && (
          <button
            type="button"
            onClick={onViewDiff}
            className="mr-auto text-[12px] text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            View full diff
          </button>
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
