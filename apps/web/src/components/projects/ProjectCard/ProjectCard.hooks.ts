/** @file Local overlay state hook for a ProjectCard. */
import { useCallback, useState } from 'react';

import type { ProjectCardProps } from './ProjectCard.types';

/** Which transient overlay (if any) the card has open. */
type Overlay = 'none' | 'confirm-remove';

/** State and actions returned by {@link useProjectCard}. */
export interface ProjectCardState {
  overlay: Overlay;
  openRemove: () => void;
  closeOverlay: () => void;
  confirmRemove: () => void;
}

/** Local overlay state for a ProjectCard remove confirmation. */
export function useProjectCard({
  project,
  onDelete,
}: Pick<ProjectCardProps, 'project' | 'onDelete'>): ProjectCardState {
  const [overlay, setOverlay] = useState<Overlay>('none');

  const openRemove = useCallback(() => setOverlay('confirm-remove'), []);
  const closeOverlay = useCallback(() => setOverlay('none'), []);

  const confirmRemove = useCallback(() => {
    onDelete?.(project.id);
    setOverlay('none');
  }, [project.id, onDelete]);

  return {
    overlay,
    openRemove,
    closeOverlay,
    confirmRemove,
  };
}
