import type { ImageFormat } from '@/lib/attachments';

/** A validated custom project image held locally until its parent submits. */
export interface ProjectIconImageDraft {
  format: ImageFormat;
  data: string;
  filename: string;
  preview: string;
}

/** Controlled values and mutations for {@link ProjectIconEditor}. */
export interface ProjectIconEditorProps {
  icon: string | null;
  imageUrl: string | null;
  hasCustomImage: boolean;
  onIconChange: (icon: string | null) => void;
  onImageChange: (image: ProjectIconImageDraft) => void;
  onRemoveImage: () => void;
  label?: string;
}
