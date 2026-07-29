import { ConfirmDialog, EditProjectDialog } from '@/components/ui';
import { pluralize } from '@/lib/formatters';

import type { AppShellState } from './AppShell.hooks';

/** Global confirm + edit-project overlays mounted once by {@link AppShell}. */
export function AppShellOverlays({
  confirm,
  editProject,
  projectRemoval,
}: Pick<AppShellState, 'confirm' | 'editProject' | 'projectRemoval'>) {
  return (
    <>
      <ConfirmDialog
        open={confirm.pendingDelete !== null}
        title="Delete this task?"
        message="This task and its run history will be removed. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={confirm.confirm}
        onCancel={confirm.cancel}
      />

      <ConfirmDialog
        open={confirm.pendingClear !== null}
        title={
          confirm.pendingClear !== null
            ? `Delete all ${confirm.pendingClear.count} tasks in ${confirm.pendingClear.columnTitle}?`
            : ''
        }
        message={
          confirm.pendingClear !== null
            ? `Every task in ${confirm.pendingClear.columnTitle} will be removed. This can't be undone.`
            : ''
        }
        confirmLabel="Delete all"
        destructive
        onConfirm={confirm.confirm}
        onCancel={confirm.cancel}
      />

      {/* Multi-select delete (#402): one confirmation for the whole selection. */}
      <ConfirmDialog
        open={confirm.pendingBulkDelete !== null}
        title={
          confirm.pendingBulkDelete !== null
            ? `Delete ${pluralize(confirm.pendingBulkDelete.length, 'selected task')}?`
            : ''
        }
        message="Every selected task and its run history will be removed. This can't be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={confirm.confirm}
        onCancel={confirm.cancel}
      />

      <EditProjectDialog
        project={editProject.editTarget}
        open={editProject.editOpen}
        onClose={editProject.closeEdit}
        onSave={editProject.saveEdit}
      />

      <ConfirmDialog
        open={projectRemoval.pending !== null}
        title="Remove project?"
        message={
          projectRemoval.pending === null ? (
            ''
          ) : (
            <>
              <span className="font-medium text-foreground">
                {projectRemoval.pending.name}
              </span>{' '}
              will be removed from Nightcore. This does not delete the repository or
              any files on disk — only its entry here.
            </>
          )
        }
        confirmLabel="Remove"
        destructive
        onConfirm={projectRemoval.confirm}
        onCancel={projectRemoval.cancel}
      />
    </>
  );
}
