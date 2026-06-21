import type { ReactNode } from 'react';

export interface SettingsRow {
  label: string;
  hint?: string;
  control: ReactNode;
}

export interface SettingsCardProps {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  /** Roadmap tag (e.g. "M2", "M3") carried from the design — kept visible. */
  badge?: string;
  rows: SettingsRow[];
}
