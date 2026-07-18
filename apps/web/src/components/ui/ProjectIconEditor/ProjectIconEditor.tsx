import { ACCEPTED_IMAGE_LABEL } from '@/lib/attachments';

import { Button } from '../Button';
import { IconPicker } from '../IconPicker/IconPicker';
import { CloseIcon, UploadIcon } from '../icons/icons';
import { ProjectIcon } from '../ProjectIcon/ProjectIcon';
import { useProjectIconEditor } from './ProjectIconEditor.hooks';
import type { ProjectIconEditorProps } from './ProjectIconEditor.types';

/** Controlled preset/custom-image editor shared by project create and edit flows. */
export function ProjectIconEditor({
  icon,
  imageUrl,
  hasCustomImage,
  onIconChange,
  onImageChange,
  onRemoveImage,
  label = 'Icon',
}: ProjectIconEditorProps) {
  const editor = useProjectIconEditor({ onIconChange, onImageChange, onRemoveImage });

  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs-plus font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-nc border border-border bg-white/[0.03]">
          <ProjectIcon
            icon={hasCustomImage ? null : icon}
            imageUrl={hasCustomImage ? imageUrl : null}
            size={28}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" type="button" onClick={() => editor.fileRef.current?.click()}>
            <UploadIcon size={14} />
            Upload
          </Button>
          {hasCustomImage && (
            <Button variant="ghost" type="button" onClick={editor.removeImage}>
              <CloseIcon size={14} />
              Remove image
            </Button>
          )}
        </div>
        <input
          ref={editor.fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="hidden"
          aria-label="Upload project image"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void editor.upload(file);
          }}
        />
      </div>
      <p className="text-2xs text-muted-foreground">
        {ACCEPTED_IMAGE_LABEL} · max 5 MB
      </p>
      <IconPicker selectedIcon={hasCustomImage ? null : icon} onSelectIcon={editor.selectIcon} />
      {editor.error !== null && (
        <p className="text-xs-plus text-destructive" role="alert">
          {editor.error}
        </p>
      )}
    </div>
  );
}
