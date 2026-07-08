/** Centered placeholder for empty or failed data states. */
import type { ReactNode } from 'react';

/** Props for {@link EmptyState}. */
interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Centered empty/zero-data placeholder — used for empty boards, no projects,
 *  no search results, and load failures (with an error-tinted icon). */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={`flex h-full flex-col items-center justify-center gap-1.5 px-6 text-center ${className ?? ''}`}
    >
      {icon !== undefined && (
        <div className="mb-2 flex h-[68px] w-[68px] items-center justify-center rounded-[18px] bg-primary/10 text-primary">
          {icon}
        </div>
      )}
      <p className="text-lg font-semibold tracking-tight">{title}</p>
      {description !== undefined && (
        <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {action !== undefined && <div className="mt-3.5">{action}</div>}
    </div>
  );
}
