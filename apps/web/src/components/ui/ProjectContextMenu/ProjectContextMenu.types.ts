import type { ReactNode } from 'react';

/** Props for {@link ProjectContextMenu}. */
export interface ProjectContextMenuProps {
  children: ReactNode;
  onEdit: () => void;
}
