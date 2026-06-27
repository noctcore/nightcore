// Image-attachment helpers shared by the create form and the task-detail editor.
// The contract image `format` is a bare token (`png`/`jpeg`/`webp`/`gif`) — see
// `@nightcore/contracts` `ImageFormatSchema` — mapped from the browser File mime
// type here. Limits mirror the Rust server-side checks (`store::attachments`); the
// server re-validates, so these are a fast UX guard, not the security boundary.

/** Max bytes per image (decoded). Mirrors `attachments::MAX_IMAGE_BYTES` (10 MB). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Max images per task. Mirrors `attachments::MAX_IMAGES_PER_TASK`. */
export const MAX_IMAGES_PER_TASK = 5;

/** The image mime types the picker accepts (the `accept` attr + drop/paste filter). */
export const ACCEPTED_IMAGE_MIME = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

/** Human label for the accepted set, shown in the dropzone hint. */
export const ACCEPTED_IMAGE_LABEL = 'PNG, JPEG, WebP, GIF';

/** The contract image format tokens (mirrors `@nightcore/contracts` ImageFormat). */
export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'gif';

/** Map a browser File mime type to a contract image format, or `null` if the type
 *  isn't an accepted image. */
export function formatFromMime(mime: string): ImageFormat | null {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpeg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return null;
  }
}

/** A pending (not-yet-persisted) attachment held in the create form: raw base64 for
 *  both the preview and the create payload, plus display metadata. */
export interface PendingAttachment {
  /** Client-only id for list keying + removal before the task exists. */
  tempId: string;
  filename: string;
  format: ImageFormat;
  /** Raw base64 of the image bytes (NO `data:` URL prefix). */
  data: string;
  size: number;
}

/** The wire payload sent to the Rust `create_task` / `add_task_attachments`. */
export interface NewAttachmentPayload {
  filename: string;
  format: ImageFormat;
  data: string;
}

/** Build a `data:` URL for an `<img src>` from a format token + raw base64. */
export function imageDataUrl(format: string, data: string): string {
  return `data:image/${format};base64,${data}`;
}

/** Strip a pending attachment down to its wire payload. */
export function toPayload(pending: PendingAttachment): NewAttachmentPayload {
  return { filename: pending.filename, format: pending.format, data: pending.data };
}

/** Read a File into raw base64 (no `data:` prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('could not read image'));
        return;
      }
      // `data:<mime>;base64,<DATA>` → keep only the base64 payload.
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('could not read image'));
    reader.readAsDataURL(file);
  });
}

/** Validate + read a File into a `PendingAttachment`. Throws an Error with a
 *  user-facing message when the type or size is rejected. */
export async function fileToPending(file: File): Promise<PendingAttachment> {
  const format = formatFromMime(file.type);
  if (format === null) {
    throw new Error(`"${file.name}" is not a supported image (${ACCEPTED_IMAGE_LABEL}).`);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new Error(`"${file.name}" is larger than 10 MB.`);
  }
  const data = await fileToBase64(file);
  return { tempId: crypto.randomUUID(), filename: file.name, format, data, size: file.size };
}

/** The outcome of reading a batch of dropped/pasted/picked image files. */
export interface ReadImagesResult {
  accepted: PendingAttachment[];
  /** Per-file rejection messages plus any "over the limit" message. */
  errors: string[];
}

/** Validate + read up to `room` image files into pending attachments, partitioning
 *  the successes from per-file error messages (and adding an over-limit message when
 *  more files than `room` were supplied). Shared by the create form and the
 *  task-detail editor so the room/validation/partition logic lives in one place. */
export async function readImageFiles(files: File[], room: number): Promise<ReadImagesResult> {
  if (room <= 0) {
    return { accepted: [], errors: [`Maximum ${MAX_IMAGES_PER_TASK} images.`] };
  }
  const errors: string[] = [];
  if (files.length > room) {
    errors.push(`Only ${room} more image${room === 1 ? '' : 's'} can be added.`);
  }
  const results = await Promise.all(
    files.slice(0, room).map((file) =>
      fileToPending(file).then(
        (pending) => ({ ok: true as const, pending }),
        (e: unknown) => ({
          ok: false as const,
          message: e instanceof Error ? e.message : 'Could not add image.',
        }),
      ),
    ),
  );
  return {
    accepted: results.flatMap((r) => (r.ok ? [r.pending] : [])),
    errors: [...errors, ...results.flatMap((r) => (r.ok ? [] : [r.message]))],
  };
}

/** Extract the image `File`s from a paste/drop `DataTransfer` (or clipboard), keeping
 *  only accepted image types. Returns `[]` when there are none — the caller then
 *  leaves the paste/drop alone (so pasting text into a textarea still works). */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (data === null) return [];
  const files: File[] = [];
  // `files` covers drops + most clipboard images; fall back to `items` for browsers
  // that only expose pasted images via the items list.
  for (const file of Array.from(data.files)) {
    if (formatFromMime(file.type) !== null) files.push(file);
  }
  if (files.length === 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind === 'file' && formatFromMime(item.type) !== null) {
        const file = item.getAsFile();
        if (file !== null) files.push(file);
      }
    }
  }
  return files;
}
