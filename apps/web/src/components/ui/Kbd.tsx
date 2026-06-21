import type { ReactNode } from 'react';

/** A keyboard-hint chip (e.g. ⌘↵, Esc, N). Mono, bordered, muted. */
export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border px-1.5 py-px font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}
