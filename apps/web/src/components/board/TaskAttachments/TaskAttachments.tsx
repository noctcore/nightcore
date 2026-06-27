import { ImageDropzone } from '@/components/ui';
import { useTaskAttachments } from './TaskAttachments.hooks';
import type { TaskAttachmentsProps } from './TaskAttachments.types';

/** The task-detail "Images" section: a read-only thumbnail grid once a task has
 *  run, or a full drag/drop/paste/picker dropzone with remove while it's still
 *  pre-run. Persists through the attachment IPC commands; the board reconciles on
 *  the `nc:task` echo, so this owns no attachment list of its own. */
export function TaskAttachments({ task, editable }: TaskAttachmentsProps) {
  const { items, canAddMore, error, addFiles, removeAttachment } = useTaskAttachments(
    task,
    editable,
  );

  return (
    <section>
      <h3 className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
        Images
      </h3>
      <ImageDropzone
        items={items}
        onAddFiles={addFiles}
        onRemove={removeAttachment}
        canAddMore={canAddMore}
        readOnly={!editable}
        error={error}
      />
    </section>
  );
}
