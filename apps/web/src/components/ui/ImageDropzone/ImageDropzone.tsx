/** Presentational image attachment zone with a thumbnail grid. */
import {
  ACCEPTED_IMAGE_LABEL,
  ACCEPTED_IMAGE_MIME,
  MAX_IMAGES_PER_TASK,
} from '@/lib/attachments';

import { CloseIcon, ImageIcon, UploadIcon } from '../icons';
import { useImageDropzone } from './ImageDropzone.hooks';
import type { ImageDropzoneProps } from './ImageDropzone.types';

/** Build the dashed drop-target class string for the current drag/enabled state. */
function dropzoneClass(isDragOver: boolean, enabled: boolean): string {
  return `flex flex-col items-center gap-1 rounded-nc border border-dashed px-3 py-4 text-center transition-colors disabled:cursor-not-allowed ${
    isDragOver ? 'border-primary bg-primary/[0.07]' : 'border-border bg-white/[0.02]'
  } ${enabled ? 'cursor-pointer hover:border-white/25' : 'opacity-60'}`;
}

/** A drag-drop + paste + file-picker image attachment zone with a thumbnail grid.
 *  Pure presentational: the parent owns the item list, validation, and persistence
 *  (so the SAME component serves both the in-memory create form and the
 *  command-backed task-detail editor). `readOnly` hides the zone + remove buttons
 *  for a task that has already run. */
export function ImageDropzone({
  items,
  onAddFiles,
  onRemove,
  canAddMore,
  disabled = false,
  error = null,
  readOnly = false,
}: ImageDropzoneProps) {
  const enabled = !disabled && !readOnly && canAddMore;
  const { isDragOver, inputRef, openPicker, onDragOver, onDragLeave, onDrop, onPaste, onInputChange } =
    useImageDropzone(onAddFiles, enabled);

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_IMAGE_MIME.join(',')}
        multiple
        hidden
        disabled={!enabled}
        onChange={onInputChange}
      />
      {!readOnly && (
        <button
          type="button"
          disabled={!enabled}
          onClick={openPicker}
          onPaste={onPaste}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          aria-label="Add images — drop, paste, or browse"
          className={dropzoneClass(isDragOver, enabled)}
        >
          <UploadIcon size={16} className="text-muted-foreground" />
          <span className="text-xs-plus text-muted-foreground">
            {canAddMore ? (
              <>
                Drop images, paste, or <span className="text-primary">browse</span>
              </>
            ) : (
              `Maximum ${MAX_IMAGES_PER_TASK} images reached`
            )}
          </span>
          <span className="text-2xs text-muted-foreground">
            {ACCEPTED_IMAGE_LABEL} · ≤10MB · {items.length}/{MAX_IMAGES_PER_TASK}
          </span>
        </button>
      )}

      {error !== null && (
        <span role="alert" className="text-2xs-plus text-destructive">
          {error}
        </span>
      )}

      {items.length > 0 && (
        <ul className="grid grid-cols-4 gap-2" aria-label="Attached images">
          {items.map((item) => (
            <li
              key={item.id}
              title={item.filename}
              className="group relative aspect-square overflow-hidden rounded-nc border border-border bg-black/20"
            >
              {item.previewUrl !== null ? (
                <img
                  src={item.previewUrl}
                  alt={`Attachment: ${item.filename}`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <ImageIcon size={16} className="text-muted-foreground/50" />
                </div>
              )}
              {!readOnly && !disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${item.filename}`}
                  onClick={() => onRemove(item.id)}
                  className="absolute right-1 top-1 rounded-full bg-black/65 p-0.5 text-white opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
