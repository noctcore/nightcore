import type { ReactNode } from 'react';

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
    'rounded-[14px] border bg-card transition-colors ' +
    (selected
      ? 'border-primary/60 shadow-[0_0_0_1px_var(--nc-primary)]'
      : 'border-border hover:border-white/20');

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`${base} text-left ${className ?? ''}`}
      >
        {children}
      </button>
    );
  }
  return <div className={`${base} ${className ?? ''}`}>{children}</div>;
}
