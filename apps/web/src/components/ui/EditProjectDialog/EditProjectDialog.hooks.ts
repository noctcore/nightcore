import { useCallback, useEffect, useState } from 'react';

import { useProjectIconProps } from '../ProjectIcon/ProjectIcon.hooks';
import type { ProjectIconImageDraft } from '../ProjectIconEditor/ProjectIconEditor.types';
import type { EditProjectDialogProps } from './EditProjectDialog.types';

/** Local state for {@link EditProjectDialog}. */
export function useEditProjectDialog({ project, open, onClose, onSave }: EditProjectDialogProps) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<ProjectIconImageDraft | null>(null);
  const [clearCustom, setClearCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iconProps = useProjectIconProps(
    project ?? { id: '', icon: null, customIconPath: null },
  );
  const previewUrl = pendingImage?.preview ?? iconProps.imageUrl;

  useEffect(() => {
    if (!open || project === null) return;
    setName(project.name);
    setIcon(project.icon);
    setPendingImage(null);
    setClearCustom(false);
    setError(null);
  }, [open, project]);

  const canSave =
    project !== null &&
    name.trim().length > 0 &&
    !saving &&
    (name.trim() !== project.name ||
      icon !== project.icon ||
      pendingImage !== null ||
      clearCustom);

  const submit = useCallback(async () => {
    if (project === null || !canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        projectId: project.id,
        name: name.trim(),
        icon: pendingImage !== null ? null : icon,
        customImage: pendingImage,
        clearCustom,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save project.');
    } finally {
      setSaving(false);
    }
  }, [canSave, clearCustom, icon, name, onClose, onSave, pendingImage, project]);

  return {
    name,
    setName,
    icon,
    setIcon,
    pendingImage,
    setPendingImage,
    clearCustom,
    setClearCustom,
    saving,
    error,
    previewUrl,
    canSave,
    submit,
  };
}
