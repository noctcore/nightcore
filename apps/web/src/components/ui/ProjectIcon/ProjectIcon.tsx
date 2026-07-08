import { FolderIcon } from '../icons/icons';
import { projectIconComponent } from './ProjectIcon.icons';
import type { ProjectIconProps } from './ProjectIcon.types';

/** Renders a project's Lucide preset or custom uploaded image. Presentational —
 *  the parent supplies `imageUrl` from {@link useProjectIconUrl}. */
export function ProjectIcon({
  icon,
  imageUrl,
  size = 16,
  className = '',
  label,
}: ProjectIconProps) {
  if (imageUrl) {
    return (
      <img
        src={imageUrl}
        alt={label ?? ''}
        width={size}
        height={size}
        className={`rounded-md object-cover ${className}`}
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
    );
  }

  const Lucide = projectIconComponent(icon);
  if (Lucide) {
    return <Lucide size={size} className={className} aria-hidden={label === undefined} />;
  }

  return <FolderIcon size={size} className={className} aria-hidden={label === undefined} />;
}
