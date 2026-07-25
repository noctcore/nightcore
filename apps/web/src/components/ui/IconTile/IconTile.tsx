/** Rounded-square accent tile that frames an icon. */
import type { ReactNode } from 'react';

/** Size of an {@link IconTile}. */
type IconTileSize = 'sm' | 'md' | 'lg' | 'xl';

/** Props for {@link IconTile}. */
interface IconTileProps {
  children: ReactNode;
  /** sm ≈ switcher/dialog (34px), md ≈ settings card header (42px), lg ≈ page
   *  header (54px), xl ≈ empty-state hero (68px). */
  size?: IconTileSize;
  className?: string;
}

const SIZES: Record<IconTileSize, string> = {
  sm: 'h-[34px] w-[34px] rounded-nc',
  md: 'h-[42px] w-[42px] rounded-xl',
  lg: 'h-[54px] w-[54px] rounded-[15px]',
  xl: 'h-[68px] w-[68px] rounded-[18px]',
};

/** A rounded-square accent tile (`bg-primary/15 text-primary`) holding an icon,
 *  used for settings card headers, the project icon, and dialog headers. The
 *  icon inside inherits `currentColor` (primary). */
export function IconTile({ children, size = 'md', className }: IconTileProps) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center bg-primary/15 text-primary ${SIZES[size]} ${className ?? ''}`}
    >
      {children}
    </span>
  );
}
