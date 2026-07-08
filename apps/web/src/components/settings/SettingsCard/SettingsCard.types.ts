/** Props and row shape for the presentational grouped settings card. */
import type { ReactNode } from 'react';

/** A single label/hint/control row inside a settings card. */
export interface SettingsRow {
  label: string;
  hint?: string;
  control: ReactNode;
  /** When true, the control renders below the label/hint at full width. */
  stacked?: boolean;
}

/** Props for the grouped settings card. */
export interface SettingsCardProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  rows: SettingsRow[];
}
