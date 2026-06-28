/** @file Local overlay state hook for a ProjectCard. */
import { useCallback, useState } from 'react';
import type { ProjectCardProps } from './ProjectCard.types';

/** Which transient overlay (if any) the card has open. */
type Overlay = 'none' | 'rename' | 'confirm-remove';

/** State and actions returned by {@link useProjectCard}. */
export interface ProjectCardState {
  overlay: Overlay;
  /** The draft name bound to the rename input. */
  draftName: string;
  setDraftName: (value: string) => void;
  /** True when the rename draft is a non-empty, changed name. */
  canRename: boolean;
  openRename: () => void;
  openRemove: () => void;
  closeOverlay: () => void;
  submitRename: () => void;
  confirmRemove: () => void;
}

/** Local overlay state for a ProjectCard: the rename dialog and the remove
 *  confirmation. The card owns this transient UI; the registry mutations are the
 *  parent's `onRename` / `onDelete`. */
export function useProjectCard({
  project,
  onRename,
  onDelete,
}: Pick<ProjectCardProps, 'project' | 'onRename' | 'onDelete'>): ProjectCardState {
  const [overlay, setOverlay] = useState<Overlay>('none');
  const [draftName, setDraftName] = useState(project.name);

  const trimmed = draftName.trim();
  const canRename = trimmed.length > 0 && trimmed !== project.name;

  const openRename = useCallback(() => {
    setDraftName(project.name);
    setOverlay('rename');
  }, [project.name]);

  const openRemove = useCallback(() => setOverlay('confirm-remove'), []);
  const closeOverlay = useCallback(() => setOverlay('none'), []);

  const submitRename = useCallback(() => {
    const next = draftName.trim();
    if (next.length === 0 || next === project.name) {
      setOverlay('none');
      return;
    }
    onRename?.(project.id, next);
    setOverlay('none');
  }, [draftName, project.id, project.name, onRename]);

  const confirmRemove = useCallback(() => {
    onDelete?.(project.id);
    setOverlay('none');
  }, [project.id, onDelete]);

  return {
    overlay,
    draftName,
    setDraftName,
    canRename,
    openRename,
    openRemove,
    closeOverlay,
    submitRename,
    confirmRemove,
  };
}
