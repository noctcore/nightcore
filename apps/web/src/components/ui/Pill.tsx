/** A read-only mono value pill (paths, versions, fixed values). */
import type { ReactNode } from 'react';

/** A read-only mono value pill (paths, versions, fixed values). */
export function Pill({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground">
      {children}
    </span>
  );
}
