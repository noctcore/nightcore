import { ConfirmDialog, EditProjectDialog } from '@/components/ui';

import type { AppShellState } from './AppShell.hooks';

/** Global confirm + edit-project overlays mounted once by {@link AppShell}. */
export function AppShellOverlays({
  confirm,
  editProject,
}: Pick<AppShellState, 'confirm' | 'editProject'>) {
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

      <EditProjectDialog
        project={editProject.editTarget}
        open={editProject.editOpen}
        onClose={editProject.closeEdit}
        onSave={editProject.saveEdit}
      />
    </>
  );
}
