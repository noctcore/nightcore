/** Constants for the Constitution editor card: preview language and tab/placeholder copy. */
import type { ConstitutionMode } from './ConstitutionCard.types';

/** The language CodeBlock highlights the pack as (it falls back to plain text for
 *  unknown languages, so this is safe even if Shiki lacks the grammar). */
export const PACK_LANGUAGE = 'markdown';

/** The two editor modes, in tab order. */
export const MODE_TABS: [value: ConstitutionMode, label: string][] = [
  ['preview', 'Preview'],
  ['edit', 'Edit'],
];

/** Shown in the preview when no pack has been authored yet (the file is absent). */
export const EMPTY_PACK_PLACEHOLDER =
  'No context pack yet. Regenerate from sources (CLAUDE.md / AGENTS.md / .nightcore/memory) or write one here.';
