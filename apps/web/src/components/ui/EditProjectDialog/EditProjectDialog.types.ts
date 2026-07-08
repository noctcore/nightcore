import type { Project } from '@/lib/bridge';

/** Props for {@link EditProjectDialog}. */
export interface EditProjectDialogProps {
  project: Project | null;
  open: boolean;
  onClose: () => void;
  onSave: (args: EditProjectSaveArgs) => Promise<void>;
}

/** Payload the dialog collects on save. */
export interface EditProjectSaveArgs {
  projectId: string;
  name: string;
  icon: string | null;
  customImage: { format: string; data: string; filename: string } | null;
  clearCustom: boolean;
}
