/** Glassy bordered container surface. */
import type { ReactNode } from 'react';

/** Props for {@link Card}. */
interface CardProps {
  children: ReactNode;
  className?: string;
  /** Renders as an interactive button when an onClick is supplied. */
  onClick?: () => void;
  selected?: boolean;
  title?: string;
}

/** Glassy bordered surface — the base container for tasks, projects, and
 *  settings groups. Becomes a focusable button when `onClick` is set. */
export function Card({ children, className, onClick, selected, title }: CardProps) {
  const base =
    'rounded-[14px] border bg-card ' +
    (selected
      ? 'border-primary/60 shadow-[0_0_0_1px_var(--nc-primary)]'
      : 'border-border hover:border-white/20');

  if (onClick) {
    // Interactive cards get a faint hover lift (a subtle brightness bump — cheaper
    // than a shadow and it doesn't clobber the selected ring) plus a slight
    // press-in on tap. Brightness/transform are gated through the transition here
    // rather than `base`'s `transition-colors` so both actually animate.
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`${base} text-left transition-[transform,filter,border-color] hover:brightness-[1.06] active:scale-[0.995] ${className ?? ''}`}
      >
        {children}
      </button>
    );
  }
  return <div className={`${base} transition-colors ${className ?? ''}`}>{children}</div>;
}
