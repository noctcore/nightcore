/** The footer confirm-accelerator hint shared by the house confirm dialogs. */
import type { ReactNode } from 'react';

import { Kbd } from '../Kbd';

/** macOS uses ⌘, everything else Ctrl — computed once for the accelerator hint
 *  (mirrors FolderBrowserDialog's local detection). */
const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** The left-aligned footer hint every house confirm dialog renders: the platform
 *  modifier + ↵ pairing (⌘↵ on macOS, Ctrl+↵ elsewhere) followed by a short label
 *  ("to confirm" / "to create" / "to save"). Renders the exact ⌘/Ctrl+↵ pairing
 *  FolderBrowserDialog already shows, so every confirm hint reads the same and
 *  matches the modifier-gated `onEnter` (see {@link isConfirmEnter}). */
export function ConfirmHint({ children }: { children: ReactNode }) {
  return (
    <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-0.5">
        <Kbd>{IS_MAC ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd>↵</Kbd>
      </span>
      {children}
    </span>
  );
}
