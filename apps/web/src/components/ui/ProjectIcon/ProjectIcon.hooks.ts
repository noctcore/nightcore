import type { Project } from '@/lib/bridge';
import { useProjectIconUrl } from '@/lib/useProjectIconUrl';

/** Resolve a {@link Project}'s custom icon URL for {@link ProjectIcon}. */
export function useProjectIconProps(project: Pick<Project, 'id' | 'icon' | 'customIconPath'>) {
  const imageUrl = useProjectIconUrl(project.id, project.customIconPath);
  return { icon: project.icon, imageUrl };
}
