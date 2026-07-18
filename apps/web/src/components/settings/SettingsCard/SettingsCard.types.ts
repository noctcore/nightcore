/** Props and row shape for the presentational grouped settings card. */
import type { ReactNode } from 'react';

/** A single label/hint/control row inside a settings card. */
export interface SettingsRow {
  label: string;
  hint?: string;
  control: ReactNode;
  /** When true, the control renders below the label/hint at full width. */
  stacked?: boolean;
  /** When true, this row always writes the GLOBAL block even on a page where the
   *  scope toggle is available — a small "Global" marker is shown so a per-project
   *  scope selection doesn't imply this row is scoped. */
  globalScoped?: boolean;
  /** Marks a dangerous control: an alert glyph beside the label + a warning label tint. */
  hazard?: boolean;
  /** When true (a `hazard` control that is currently ON), the row gets a warning-tinted
   *  background so an armed footgun is impossible to miss. */
  hazardActive?: boolean;
}

/** Props for the grouped settings card. */
export interface SettingsCardProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  rows: SettingsRow[];
  /** An optional caveat line rendered beneath the rows (e.g. issue #313: the
   *  default provider can't enforce a ceiling the rows above configure). */
  note?: string;
}
