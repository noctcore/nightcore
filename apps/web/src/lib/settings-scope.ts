/** Settings scope, DERIVED from the real settings shape.
 *
 *  A settings control is either global (one value for every project) or per-project
 *  (the open project can override it). That distinction is not cosmetic — it is what
 *  the user is actually agreeing to when they flip a switch — and the Settings surface
 *  used to assert it by hand, in a page-id list and a per-row boolean that nothing
 *  checked against the shape.
 *
 *  The overridable field set now comes from `settings-scope.generated.ts`, generated
 *  from the Rust `SettingsOverride` struct via its ts-rs binding
 *  (`bun run codegen:settings-scope`, gated by `codegen:check`). This module is the
 *  thin, typed read side: a field is per-project iff the override shape can carry it. */
import type { SettingsPatch } from './bridge';
import { PROJECT_OVERRIDABLE_SETTINGS } from './settings-scope.generated';

/** Which scope a settings edit lands in. */
export type SettingScope = 'global' | 'project';

/** Any settings field a control can patch. `projectId` is the patch's TARGET, not a
 *  setting, so it is excluded — derived from `SettingsPatch` so a row can only ever
 *  name a field that actually exists on the wire. */
export type SettingsField = Exclude<keyof SettingsPatch, 'projectId'>;

/** The scope a field is edited in: `project` when a per-project override can carry it,
 *  `global` otherwise. */
export function settingScope(field: SettingsField): SettingScope {
  return field in PROJECT_OVERRIDABLE_SETTINGS ? 'project' : 'global';
}

/** Whether the open project can override this field. */
export function isProjectOverridable(field: SettingsField): boolean {
  return settingScope(field) === 'project';
}

/** Whether ANY of these fields is per-project — i.e. whether a settings page has a
 *  real scope choice to offer, or is global end to end. */
export function hasProjectScope(fields: readonly SettingsField[]): boolean {
  return fields.some(isProjectOverridable);
}
