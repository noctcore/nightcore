/** Props and view-mode type for the Constitution editor card. */

/** Props for the Constitution editor card. */
export interface ConstitutionCardProps {
  /** Whether the context pack is injected for the selected scope (effective value:
   *  the project override, else the global toggle). */
  enabled: boolean;
  /** Toggle injection on/off. Routed to the global block or the active project's
   *  override by the parent scope (same as every other scoped control). */
  onToggleEnabled: (next: boolean) => void;
  /** Whether a project is active. With none active there is no `context.md` to
   *  edit, so the editor renders an empty state. */
  projectActive: boolean;
}

/** Which view the editor is in: a Shiki-highlighted preview or a raw textarea. */
export type ConstitutionMode = 'preview' | 'edit';
