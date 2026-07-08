import { useCallback, useRef, useState } from 'react';

import { fileToProjectIcon } from '@/lib/attachments';

import type {
  ProjectIconEditorProps,
  ProjectIconImageDraft,
} from './ProjectIconEditor.types';

/** File-input and validation behavior shared by project create/edit dialogs. */
export function useProjectIconEditor({
  onIconChange,
  onImageChange,
  onRemoveImage,
}: Pick<
  ProjectIconEditorProps,
  'onIconChange' | 'onImageChange' | 'onRemoveImage'
>) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const resetInput = useCallback(() => {
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const upload = useCallback(
    async (file: File) => {
      try {
        const payload = await fileToProjectIcon(file);
        const image: ProjectIconImageDraft = {
          ...payload,
          preview: `data:image/${payload.format};base64,${payload.data}`,
        };
        onImageChange(image);
        setError(null);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not read image.');
      }
    },
    [onImageChange],
  );

  const selectIcon = useCallback(
    (icon: string | null) => {
      resetInput();
      setError(null);
      onIconChange(icon);
    },
    [onIconChange, resetInput],
  );

  const removeImage = useCallback(() => {
    resetInput();
    setError(null);
    onRemoveImage();
  }, [onRemoveImage, resetInput]);

  return { fileRef, error, upload, selectIcon, removeImage };
}
