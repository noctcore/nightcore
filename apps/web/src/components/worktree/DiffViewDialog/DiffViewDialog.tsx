/** Modal listing the files changed in a worktree vs its base branch. */
import {
  BranchIcon,
  CloseIcon,
  EmptyState,
  IconButton,
  IconTile,
  Modal,
  Spinner,
  useLastPresent,
} from '@/components/ui';
import { splitPathLeaf } from '@/lib/path-display';

import { DiffPatchView } from '../DiffPatchView';
import { diffStatusMeta, useFilePatch } from './DiffViewDialog.hooks';
import type { DiffViewDialogProps } from './DiffViewDialog.types';

/** A modal listing the changed files in a worktree against its base: a header
 *  with the title + git summary line over a scrollable file list. Each row is a
 *  toggle button — a status pill, the (truncated, monospace) path, and its
 *  `+adds −dels` count — that expands an inline, lazily-fetched unified-diff
 *  patch for that file (T13's per-file patch viewer).
 *
 *  The file list arrives via props (the parent owns the `worktree_diff` call);
 *  the per-file patch is fetched here via `useFilePatch(taskId)`. Built on the
 *  shared `<Modal>` primitive, so it gets the focus trap + Esc / click-outside
 *  close for free. Renders nothing when `open` is false. */
export function DiffViewDialog({
  open,
  diff,
  taskId,
  loading = false,
  onClose,
  title = 'Changed files',
}: DiffViewDialogProps) {
  // Retain the diff across the exit animation so the list doesn't blank when the
  // parent clears it on close. `loading`/`onClose`/`title` stay live.
  const shownDiff = useLastPresent(diff);
  const { expandedPath, patch, loading: patchLoading, toggle } = useFilePatch(taskId);
  const files = shownDiff?.files ?? [];
  const isEmpty = !loading && files.length === 0;

  return (
    <Modal
      open={open}
      label={title}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      panelClassName="flex max-h-[80vh] w-[560px] max-w-full flex-col"
    >
      <header className="flex items-center gap-3 border-b border-border px-5 py-4">
        <IconTile size="sm">
          <BranchIcon size={16} />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="text-base font-semibold text-foreground">{title}</div>
          {shownDiff !== null && shownDiff.summary.length > 0 && (
            <div
              className="truncate font-mono text-2xs-plus text-muted-foreground"
              title={shownDiff.summary}
            >
              {shownDiff.summary}
            </div>
          )}
        </div>
        <IconButton label="Close dialog" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </header>

      <div className="min-h-[220px] flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center py-12 text-muted-foreground">
            <Spinner size={20} />
          </div>
        ) : isEmpty ? (
          <EmptyState title="No changed files" description="This worktree matches its base branch." />
        ) : (
          <ul className="flex flex-col py-1">
            {files.map((file) => {
              const meta = diffStatusMeta(file.status);
              const isOpen = expandedPath === file.path;
              const { dir, leaf } = splitPathLeaf(file.path);
              return (
                <li key={file.path} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => toggle(file.path)}
                    aria-expanded={isOpen}
                    className={`flex items-center gap-2.5 px-5 py-1.5 text-left transition-colors hover:bg-white/[0.03] ${
                      isOpen ? 'bg-white/[0.04]' : ''
                    }`}
                  >
                    <span
                      title={meta.label}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-mono text-2xs font-semibold ${meta.pill}`}
                    >
                      {meta.letter}
                    </span>
                    <span
                      title={file.path}
                      className="flex min-w-0 flex-1 font-mono text-xs-plus2 text-foreground"
                    >
                      {dir.length > 0 && (
                        <span className="truncate text-muted-foreground/70">{dir}</span>
                      )}
                      <span className="shrink-0">{leaf}</span>
                    </span>
                    <span className="shrink-0 font-mono text-2xs tabular-nums">
                      <span className="text-success">+{file.additions}</span>{' '}
                      <span className="text-destructive">−{file.deletions}</span>
                    </span>
                  </button>
                  {isOpen && <DiffPatchView patch={patch} loading={patchLoading} />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}
