/** A read-only mono field — a presentational stand-in for text inputs. */
import type { ReactNode } from 'react';

/** A read-only mono field — a presentational stand-in for text inputs. */
export function FieldValue({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="block w-full rounded-lg border border-border bg-black/20 px-3 py-2.5 font-mono text-[12.5px] text-foreground">
      {children}
    </span>
  );
}
