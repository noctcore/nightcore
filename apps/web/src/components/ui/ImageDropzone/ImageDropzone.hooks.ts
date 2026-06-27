import { useCallback, useRef, useState } from 'react';
import type { ChangeEvent, ClipboardEvent, DragEvent } from 'react';
import { imageFilesFrom } from '@/lib/attachments';

/** Drag/drop/paste/picker wiring for the image dropzone. `enabled` is false when the
 *  zone is disabled, read-only, or at the image limit — every add affordance no-ops.
 *  Pure event plumbing; the parent owns validation + persistence of the files. */
export function useImageDropzone(onAddFiles: (files: File[]) => void, enabled: boolean) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const openPicker = useCallback(() => {
    if (enabled) inputRef.current?.click();
  }, [enabled]);

  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (!enabled) return;
      e.preventDefault();
      setIsDragOver(true);
    },
    [enabled],
  );

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!enabled) return;
      e.preventDefault();
      setIsDragOver(false);
      const files = imageFilesFrom(e.dataTransfer);
      if (files.length > 0) onAddFiles(files);
    },
    [enabled, onAddFiles],
  );

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!enabled) return;
      const files = imageFilesFrom(e.clipboardData);
      // Only intercept the paste when it carries images — otherwise leave it alone so
      // text paste in an adjacent field is unaffected.
      if (files.length > 0) {
        e.preventDefault();
        onAddFiles(files);
      }
    },
    [enabled, onAddFiles],
  );

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) onAddFiles(files);
      // Reset so re-selecting the same file fires `change` again.
      e.target.value = '';
    },
    [onAddFiles],
  );

  return {
    isDragOver,
    inputRef,
    openPicker,
    onDragOver,
    onDragLeave,
    onDrop,
    onPaste,
    onInputChange,
  };
}
