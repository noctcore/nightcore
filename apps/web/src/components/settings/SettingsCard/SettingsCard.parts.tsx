/** The scope badge: says whether a row is global or per-project, and jumps to where it
 *  applies. Split out of `SettingsCard.tsx` so the card stays a thin renderer. */
import type { ReactNode } from 'react';

import { settingScope } from '@/lib/settings-scope';

import type { SettingsRow, SettingsScopeSurface } from './SettingsCard.types';

const CHIP =
  'mr-1.5 inline-block max-w-[160px] truncate rounded px-1 py-px align-[1px] font-mono text-4xs-plus uppercase tracking-[0.06em]';
const STATIC_CHIP = `${CHIP} bg-white/[0.06] text-muted-foreground`;
const LINK_CHIP = `${CHIP} cursor-pointer bg-white/[0.06] text-muted-foreground transition-colors hover:bg-white/[0.12] hover:text-foreground`;
const PROJECT_CHIP = `${CHIP} cursor-pointer bg-primary/[0.14] text-primary transition-colors hover:bg-primary/[0.22]`;

function ScopeLink({
  className,
  title,
  label,
  onClick,
  children,
}: {
  className: string;
  title: string;
  /** Spelled-out accessible name — the visible chip text is a terse abbreviation. */
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={label} className={className}>
      {children}
    </button>
  );
}

/**
 * A row's scope badge.
 *
 * Four honest states, all derived from whether the Rust `SettingsOverride` shape can
 * carry the row's field (never from a hand-kept page list):
 *
 *  - **global** → a static `Global` chip. It writes one value for every project, even
 *    while the project tab is selected — the case the old per-row `globalScoped` flag
 *    existed to admit, now impossible to get wrong.
 *  - **per-project, no project open** → a static `Per-project` chip: overridable, but
 *    there is nothing to override it for yet.
 *  - **per-project, global tab** → `Global default`, as a BUTTON that switches to the
 *    project tab: "jump to where this setting would actually apply".
 *  - **per-project, project tab** → the project's name, as a button back to the global
 *    default, so the user always knows which of the two values they are editing.
 */
export function ScopeBadge({
  field,
  surface,
}: {
  field: NonNullable<SettingsRow['field']>;
  surface: SettingsScopeSurface;
}) {
  if (settingScope(field) === 'global') {
    return (
      <span
        className={STATIC_CHIP}
        title="Global — one value for every project. The project tab does not change it."
      >
        Global
      </span>
    );
  }

  const project = surface.projectName;
  if (project === null) {
    return (
      <span
        className={STATIC_CHIP}
        title="This setting can be overridden per project — open a project to set one."
      >
        Per-project
      </span>
    );
  }

  if (surface.scope === 'project') {
    return (
      <ScopeLink
        className={PROJECT_CHIP}
        title={`Applies to ${project} only. Other projects keep the global default.`}
        label={`Applies to ${project} only — edit the global default instead`}
        onClick={() => surface.onScopeChange('global')}
      >
        {project}
      </ScopeLink>
    );
  }

  return (
    <ScopeLink
      className={LINK_CHIP}
      title={`The default for every project. Set it for ${project} only instead.`}
      label={`Global default — set this for ${project} only`}
      onClick={() => surface.onScopeChange('project')}
    >
      Global default
    </ScopeLink>
  );
}
