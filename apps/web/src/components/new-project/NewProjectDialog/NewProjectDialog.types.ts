export interface NewProjectDraft {
  folder: string | null;
  name: string;
  model: string;
  concurrency: number;
}

export interface NewProjectDialogProps {
  models: string[];
  onChooseFolder: () => void | Promise<void>;
  onCreate: (draft: NewProjectDraft) => void | Promise<void>;
  onClose: () => void;
  /** Pre-selected folder once chosen (drives the create button's enabled state). */
  folder?: string | null;
}
