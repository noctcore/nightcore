import { Button } from '../Button';
import { IconPicker } from '../IconPicker/IconPicker';
import { CloseIcon, UploadIcon } from '../icons/icons';
import { Kbd } from '../Kbd';
import { Modal } from '../Modal';
import { ProjectIcon } from '../ProjectIcon/ProjectIcon';
import { useEditProjectDialog } from './EditProjectDialog.hooks';
import type { EditProjectDialogProps } from './EditProjectDialog.types';

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-black/20 px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary';

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
        <label className="flex flex-col gap-1.5 text-[12.5px] font-medium text-muted-foreground">
          Name
          <input
            value={dialog.name}
            onChange={(e) => dialog.setName(e.target.value)}
            aria-label="Project name"
            className={INPUT_CLASS}
          />
        </label>
        <div className="flex flex-col gap-2">
          <span className="text-[12.5px] font-medium text-muted-foreground">Icon</span>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-[10px] border border-border bg-white/[0.03]">
              <ProjectIcon
                icon={dialog.pendingImage !== null ? null : dialog.icon}
                imageUrl={dialog.previewUrl}
                size={28}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="ghost" type="button" onClick={() => dialog.fileRef.current?.click()}>
                <UploadIcon size={14} />
                Upload
              </Button>
              {(dialog.pendingImage !== null || project.customIconPath !== null) &&
                !dialog.clearCustom && (
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      dialog.setPendingImage(null);
                      dialog.setClearCustom(true);
                      if (dialog.fileRef.current) dialog.fileRef.current.value = '';
                    }}
                  >
                    <CloseIcon size={14} />
                    Remove image
                  </Button>
                )}
            </div>
            <input
              ref={dialog.fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void dialog.handleUpload(file);
              }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {dialog.acceptedLabel} · max 5 MB
          </p>
          <IconPicker
            selectedIcon={dialog.pendingImage !== null ? null : dialog.icon}
            onSelectIcon={(next) => {
              dialog.setIcon(next);
              dialog.setPendingImage(null);
              dialog.setClearCustom(false);
              if (dialog.fileRef.current) dialog.fileRef.current.value = '';
            }}
          />
        </div>
        {dialog.error !== null && (
          <p className="text-[12.5px] text-destructive" role="alert">
            {dialog.error}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-black/15 px-5 py-3.5">
        <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>↵</Kbd> to save
        </span>
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
