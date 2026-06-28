/** State hook for the task-detail Images section: thumbnail loading plus add/remove
 *  via the attachment IPC commands. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ImageDropzoneItem } from '@/components/ui';
import {
  addTaskAttachments,
  readTaskAttachment,
  removeTaskAttachment,
  type Task,
} from '@/lib/bridge';
import { imageDataUrl, MAX_IMAGES_PER_TASK, readImageFiles, toPayload } from '@/lib/attachments';

/** The state and actions returned by `useTaskAttachments` for the Images section. */
export interface TaskAttachmentsState {
  items: ImageDropzoneItem[];
  canAddMore: boolean;
  error: string | null;
  addFiles: (files: File[]) => void;
  removeAttachment: (attachmentId: string) => void;
}

/** State for the task-detail Images section: lazily fetches each persisted
 *  attachment's bytes for the thumbnail, and (when `editable`) adds/removes via the
 *  attachment IPC commands. The commands emit `nc:task`, so the board (and this
 *  drawer's `task` prop) reconciles automatically — no local list to keep in sync. */
export function useTaskAttachments(task: Task, editable: boolean): TaskAttachmentsState {
  const [previews, setPreviews] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef<Set<string>>(new Set());
  const taskId = task.id;
  const attachments = task.attachments;

  // Drop the cache when the drawer switches to a different task.
  useEffect(() => {
    loadedRef.current = new Set();
    setPreviews(new Map());
    setError(null);
  }, [taskId]);

  // Fetch each attachment's base64 once for its thumbnail.
  useEffect(() => {
    let cancelled = false;
    for (const att of attachments) {
      if (loadedRef.current.has(att.id)) continue;
      loadedRef.current.add(att.id);
      void readTaskAttachment(taskId, att.id)
        .then((base64) => {
          if (cancelled || base64 === '') return;
          setPreviews((prev) => new Map(prev).set(att.id, imageDataUrl(att.format, base64)));
        })
        .catch(() => {
          // Allow a later retry if the read failed (e.g. transient).
          loadedRef.current.delete(att.id);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [taskId, attachments]);

  const addFiles = useCallback(
    async (files: File[]) => {
      setError(null);
      const { accepted, errors } = await readImageFiles(
        files,
        MAX_IMAGES_PER_TASK - attachments.length,
      );
      const failed = [...errors];
      if (accepted.length > 0) {
        try {
          // Persist via the command; the `nc:task` echo reconciles the board.
          await addTaskAttachments(taskId, accepted.map(toPayload));
        } catch (e) {
          failed.push(e instanceof Error ? e.message : 'Could not save images.');
        }
      }
      if (failed.length > 0) setError(failed.join(' '));
    },
    [taskId, attachments],
  );

  const removeAttachment = useCallback(
    async (attachmentId: string) => {
      setError(null);
      try {
        await removeTaskAttachment(taskId, attachmentId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not remove image.');
      }
    },
    [taskId],
  );

  const items: ImageDropzoneItem[] = attachments.map((att) => ({
    id: att.id,
    filename: att.filename,
    previewUrl: previews.get(att.id) ?? null,
    size: att.size,
  }));

  return {
    items,
    canAddMore: editable && attachments.length < MAX_IMAGES_PER_TASK,
    error,
    addFiles: (files) => void addFiles(files),
    removeAttachment: (id) => void removeAttachment(id),
  };
}
