import { Button } from '../Button';
import { ConfirmHint } from '../ConfirmHint';
import { Modal } from '../Modal';
import { ProjectIconEditor } from '../ProjectIconEditor/ProjectIconEditor';
import { useEditProjectDialog } from './EditProjectDialog.hooks';
import type { EditProjectDialogProps } from './EditProjectDialog.types';

const INPUT_CLASS =
  'w-full rounded-nc border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';

/** Edit a project's display name, Lucide preset, or custom uploaded icon. */
export function EditProjectDialog(props: EditProjectDialogProps) {
  const { project, open, onClose } = props;
  const dialog = useEditProjectDialog(props);

  if (project === null) return null;

  return (
    <Modal
      open={open}
      label="Edit project"
      onClose={onClose}
      onEnter={dialog.canSave ? dialog.submit : undefined}
    >
      <div className="flex flex-col gap-4 px-5 pb-4 pt-5">
        <h2 className="text-base font-semibold text-foreground">Edit project</h2>
        <label className="flex flex-col gap-1.5 text-xs-plus font-medium text-muted-foreground">
          Name
          <input
            value={dialog.name}
            onChange={(e) => dialog.setName(e.target.value)}
            aria-label="Project name"
            className={INPUT_CLASS}
          />
        </label>
        <ProjectIconEditor
          icon={dialog.icon}
          imageUrl={dialog.previewUrl}
          hasCustomImage={
            dialog.pendingImage !== null ||
            (project.customIconPath !== null && !dialog.clearCustom)
          }
          onIconChange={(next) => {
            dialog.setIcon(next);
            dialog.setPendingImage(null);
            dialog.setClearCustom(project.customIconPath !== null);
          }}
          onImageChange={(image) => {
            dialog.setPendingImage(image);
            dialog.setIcon(null);
            dialog.setClearCustom(false);
          }}
          onRemoveImage={() => {
            dialog.setPendingImage(null);
            dialog.setClearCustom(true);
          }}
        />
        {dialog.error !== null && (
          <p className="text-xs-plus text-destructive" role="alert">
            {dialog.error}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <ConfirmHint>to save</ConfirmHint>
        <Button variant="ghost" onClick={onClose} disabled={dialog.saving}>
          Cancel
        </Button>
        <Button onClick={() => void dialog.submit()} disabled={!dialog.canSave}>
          {dialog.saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Modal>
  );
}
