export interface NewTaskFormProps {
  onCreate: (title: string, description: string) => Promise<void>;
  onClose: () => void;
}
