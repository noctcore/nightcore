/** The Nightcore brand mark SVG. */
import { useId } from 'react';

/** Props for {@link BrandMark}. */
interface BrandMarkProps {
  /** Rendered width/height in px (typically ~30 in the sidebar, ~96 on the splash). */
  size?: number;
  className?: string;
}

/** The Nightcore brand mark: a gradient crescent moon with a glow (viewBox
 *  0 0 64 64). Each instance mints a unique gradient id so multiple marks on one
 *  page never clash. */
export function BrandMark({ size = 30, className }: BrandMarkProps) {
  const gradientId = useId();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label="Nightcore"
      className={className}
      style={{
        display: 'block',
        filter: 'drop-shadow(0 4px 14px oklch(78% .22 290 / .35))',
      }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="oklch(82% .16 300)" />
          <stop offset="1" stopColor="oklch(64% .26 295)" />
        </linearGradient>
      </defs>
      <circle
        cx="32"
        cy="32"
        r="30"
        stroke={`url(#${gradientId})`}
        strokeWidth="2.5"
        opacity="0.32"
      />
      <path
        d="M42 12a22 22 0 1 0 10 26 17 17 0 1 1-10-26z"
        fill={`url(#${gradientId})`}
      />
      <circle cx="44" cy="22" r="3.4" fill="oklch(96% .04 300)" />
      <circle cx="13" cy="46" r="1.7" fill="oklch(82% .16 300)" opacity="0.9" />
      <circle cx="50" cy="48" r="1.3" fill="oklch(82% .16 300)" opacity="0.7" />
    </svg>
  );
}
