/** State + file-picking logic for the Board Background panel (kept out of the .tsx
 *  per the folder-per-component convention). */
import { useCallback, useRef, useState } from 'react';

import { ACCEPTED_IMAGE_MIME, fileToBackgroundImage } from '@/lib/attachments';

import type { PickedBackgroundImage } from './BoardBackgroundPanel.types';

/** The `accept` attribute for the hidden file input. */
export const BACKGROUND_ACCEPT = ACCEPTED_IMAGE_MIME.join(',');

/** Drive the "Change Image" file picker: a hidden `<input type="file">`, opening it,
 *  and validating + reading the chosen file into a `{ format, data }` payload handed
 *  to `onPick`. Surfaces a validation/read error and a busy flag while persisting. */
export function useBackgroundPicker(
  onPick: (image: PickedBackgroundImage) => Promise<void> | void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const openPicker = useCallback(() => {
    setError(null);
    inputRef.current?.click();
  }, []);

  const onInputChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so re-picking the SAME file still fires onChange.
      e.target.value = '';
      if (file === undefined) return;
      setBusy(true);
      setError(null);
      try {
        const image = await fileToBackgroundImage(file);
        await onPick(image);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load image.');
      } finally {
        setBusy(false);
      }
    },
    [onPick],
  );

  return { inputRef, openPicker, onInputChange, error, busy };
}
