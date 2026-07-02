/** Prop types for the Board Background settings panel. */
import type { ImageFormat } from '@/lib/attachments';
import type { BoardAppearance } from '@/lib/bridge';

/** A picked background image ready to persist (format token + raw base64). */
export interface PickedBackgroundImage {
  format: ImageFormat;
  data: string;
}

export interface BoardBackgroundPanelProps {
  /** The project's resolved board-appearance knobs (the panel's control values). */
  appearance: BoardAppearance;
  /** The current background image as a `data:` URL, or `null` when none is set. */
  backgroundUrl: string | null;
  /** Persist a knob change. The panel always sends the COMPLETE next appearance
   *  (matching the whole-object-replace merge on the Rust side). */
  onChangeAppearance: (next: BoardAppearance) => void;
  /** Persist a newly picked background image (writes bytes + records the ref). */
  onPickImage: (image: PickedBackgroundImage) => Promise<void> | void;
  /** Clear the current background image (drops ref + bytes). */
  onClearImage: () => Promise<void> | void;
  /** Close the panel. */
  onClose: () => void;
}
