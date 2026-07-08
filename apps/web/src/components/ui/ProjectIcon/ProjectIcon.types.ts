/** Props for {@link ProjectIcon}. */
export interface ProjectIconProps {
  /** Lucide export name (preset icon). Ignored when `imageUrl` is set. */
  icon?: string | null;
  /** Custom image `data:` URL from `read_project_icon`. */
  imageUrl?: string | null;
  size?: number;
  className?: string;
  /** Accessible label when the icon stands alone (rail squares). */
  label?: string;
}
