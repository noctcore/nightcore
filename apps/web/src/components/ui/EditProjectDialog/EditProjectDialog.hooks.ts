import { useCallback, useEffect, useRef, useState } from 'react';

import { ACCEPTED_IMAGE_LABEL, fileToProjectIcon } from '@/lib/attachments';

import { useProjectIconProps } from '../ProjectIcon/ProjectIcon.hooks';
import type { EditProjectDialogProps } from './EditProjectDialog.types';

/** Local state for {@link EditProjectDialog}. */
export function useEditProjectDialog({ project, open, onClose, onSave }: EditProjectDialogProps) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<{
    format: string;
    data: string;
    filename: string;
    preview: string;
  } | null>(null);
  const [clearCustom, setClearCustom] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  const handleUpload = useCallback(async (file: File) => {
    try {
      const payload = await fileToProjectIcon(file);
      setPendingImage({
        ...payload,
        preview: `data:image/${payload.format};base64,${payload.data}`,
      });
      setIcon(null);
      setClearCustom(false);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read image.');
    }
  }, []);

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
    fileRef,
    previewUrl,
    canSave,
    handleUpload,
    submit,
    acceptedLabel: ACCEPTED_IMAGE_LABEL,
  };
}
