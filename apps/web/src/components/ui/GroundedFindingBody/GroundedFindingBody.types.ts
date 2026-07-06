/** Props for {@link GroundedFindingBody}. */
import type { ReactNode } from 'react';

/** The shared grounded-finding body sections, rendered in the canonical order:
 *  lead → description → afterDescription → location → rationale → suggestion →
 *  before/after code → extra → affected files → tags. A section renders only
 *  when its field is present. */
export interface GroundedFindingSections {
  /** Family sections rendered before the description (e.g. an artifact target). */
  lead?: ReactNode;
  /** The main body text ("What"), rendered as sanitized Markdown by default. */
  description: string;
  /** Section title for the description (default `What`). */
  descriptionTitle?: string;
  /** Render the description as INERT pre-wrap text — for model-authored bodies
   *  that must never go through Markdown / dangerouslySetInnerHTML. */
  descriptionInert?: boolean;
  /** Family sections slotted between the description and the location chip. */
  afterDescription?: ReactNode;
  /** Pre-formatted grounded `file:line` chip; the section is omitted when null. */
  location?: string | null;
  rationale?: string | null;
  /** Section title for the rationale (default `Why it matters`). */
  rationaleTitle?: string;
  suggestion?: string | null;
  /** Section title for the suggestion (default `Suggested fix`). */
  suggestionTitle?: string;
  /** Render the suggestion as a read-only CodeBlock instead of Markdown. */
  suggestionCode?: boolean;
  codeBefore?: string | null;
  codeAfter?: string | null;
  /** Highlight language for the code sections (see {@link inferLanguageFromFile}). */
  language?: string;
  /** Family sections slotted after the shared code sections. */
  extra?: ReactNode;
  affectedFiles?: readonly string[];
  tags?: readonly string[];
}

/** The resolved panel view a family's `render` returns for the retained item. */
export interface GroundedFindingView {
  /** Accessible dialog name (defaults to the title). */
  label?: string;
  title: string;
  /** Optional element before the header badge column (e.g. a big grade chip). */
  headerLead?: ReactNode;
  /** The family-specific header badge row. */
  badges: ReactNode;
  /** The family-specific footer action row. */
  footer: ReactNode;
  sections: GroundedFindingSections;
}

export interface GroundedFindingBodyProps<T> {
  /** Presence flag — the sheet slides in/out; keep it always-mounted. */
  open: boolean;
  /** The selected item; the sheet retains the last one while animating out. */
  item: T | null;
  onClose: () => void;
  /** Widen the sheet (`max-w-2xl`) for full-file previews. */
  wide?: boolean;
  /** Resolve the retained item into the panel view (badges/footer/sections). */
  render: (shown: T) => GroundedFindingView;
}

/** Props for {@link GroundedLifecycleFooter} — the shared convert / dismiss /
 *  restore action triple keyed off the item's lifecycle status. */
export interface GroundedLifecycleFooterProps {
  /** The item's lifecycle status (`open` / `dismissed` / `converted`). */
  status: 'open' | 'dismissed' | 'converted';
  /** True while any lifecycle action is in flight (disables the buttons). */
  pending: boolean;
  onConvert: () => void;
  onDismiss: () => void;
  onRestore: () => void;
  /** Navigate to the linked board task (shown once converted). */
  onGotoBoard?: () => void;
}
