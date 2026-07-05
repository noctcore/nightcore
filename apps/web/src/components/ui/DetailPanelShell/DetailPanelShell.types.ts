/** Props for {@link DetailPanelShell}. */
import type { ReactNode } from 'react';

export interface DetailPanelShellProps {
  /** Presence flag — the sheet slides in/out. Keep it always-mounted and toggle
   *  `open` instead of `{selected && <…DetailPanel/>}`. */
  open: boolean;
  /** Accessible name for the dialog. */
  label: string;
  onClose: () => void;
  /** Optional element rendered before the badge column (e.g. a big grade chip). */
  headerLead?: ReactNode;
  /** The header badge row (severity, category, kind, confidence…). */
  badges: ReactNode;
  /** The header title heading. */
  title: string;
  /** The body sections (typically {@link DetailSection}s). */
  children: ReactNode;
  /** The footer action row (lifecycle buttons). */
  footer: ReactNode;
}
