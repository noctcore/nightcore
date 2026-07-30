/** Props and row shape for the presentational grouped settings card. */
import type { ReactNode } from 'react';

import type { SettingScope, SettingsField } from '@/lib/settings-scope';

/** What a card needs to tell the truth about scope, and to jump the user to where a
 *  setting actually applies. Supplied by `SettingsView` only on pages that HAVE a
 *  per-project choice (derived from the fields their rows declare); a page that is
 *  global end to end says so once in its header instead of on every row. */
export interface SettingsScopeSurface {
  /** The scope tab currently selected. */
  scope: SettingScope;
  /** The open project's name, or `null` when no project is active (no override
   *  target exists, so a per-project row can only be described, not set). */
  projectName: string | null;
  /** Switch the scope tab — the deep-link behind a row's scope badge. */
  onScopeChange: (next: SettingScope) => void;
}

/** A single label/hint/control row inside a settings card. */
export interface SettingsRow {
  label: string;
  hint?: string;
  control: ReactNode;
  /** The settings field this row writes. Declaring it is what makes the row's scope
   *  badge TRUE: the badge is derived from the generated per-project-overridable set
   *  (`@/lib/settings-scope`, from the Rust `SettingsOverride` shape), never asserted
   *  by hand. Omit it for rows that write no setting (a version readout, a cross-link
   *  to another page, an action button). */
  field?: SettingsField;
  /** When true, the control renders below the label/hint at full width. */
  stacked?: boolean;
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
  /** Scope context for the badges. Absent ⇒ this page has no per-project choice, so
   *  rows render without a badge (the header's static "Global" pill covers it). */
  scopeSurface?: SettingsScopeSurface;
}
