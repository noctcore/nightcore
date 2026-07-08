/** Square icon-only button with a required accessible name. */
import type { ReactNode } from 'react';

import { m } from '../motion';

/** Props for {@link IconButton}. */
interface IconButtonProps {
  children: ReactNode;
  onClick?: () => void;
  /** Required accessible name — icon buttons have no text content. */
  label: string;
  className?: string;
}

/** A square, muted icon-only button with an accessible name. Lifts on hover and
 *  presses in on tap (transform-only via motion). */
export function IconButton({ children, onClick, label, className }: IconButtonProps) {
  return (
    <m.button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      whileHover={{ y: -1 }}
      whileTap={{ scale: 0.94 }}
      className={`flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground ${className ?? ''}`}
    >
      {children}
    </m.button>
  );
}
