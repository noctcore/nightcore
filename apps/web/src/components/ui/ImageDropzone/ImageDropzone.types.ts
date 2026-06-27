export interface ImageDropzoneItem {
  /** Stable id for keying + removal: a tempId for a pending (create-time) image, or
   *  the persisted attachment id once the task exists. */
  id: string;
  filename: string;
  /** A `data:` URL for the `<img>` preview, or `null` while the bytes are still
   *  loading (persisted images are fetched lazily). */
  previewUrl: string | null;
  /** Byte size, when known (shown as a tooltip). */
  size?: number;
}

export interface ImageDropzoneProps {
  /** The images to show in the thumbnail grid. */
  items: ImageDropzoneItem[];
  /** Image files chosen via drop / paste / file picker. The parent validates, reads,
   *  and persists them (and surfaces any rejection via `error`). */
  onAddFiles: (files: File[]) => void;
  /** Remove one item by id. */
  onRemove: (id: string) => void;
  /** Whether more images can be added (count < max). Disables the add affordances and
   *  shows the limit message. */
  canAddMore: boolean;
  /** Disable the whole control (e.g. while a task is running). */
  disabled?: boolean;
  /** A validation/load error to surface beneath the zone. */
  error?: string | null;
  /** Hide the drop zone and remove buttons, showing only the thumbnail grid
   *  (read-only display once a task has run). */
  readOnly?: boolean;
}
