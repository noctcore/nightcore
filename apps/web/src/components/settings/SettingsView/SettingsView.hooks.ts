import { useCallback, useMemo, useState } from 'react';
import type { SettingsPatch } from '@/lib/bridge';
import type { SettingsScope, SettingsViewProps } from './SettingsView.types';

/** The run-shaping values currently in effect for the selected scope. Under the
 *  Project scope, a field falls back to the global value when the override is
 *  unset, so the controls always show what a run would actually use. */
export interface EffectiveSettings {
  defaultModel: string;
  defaultEffort: string;
  maxConcurrency: number;
  permissionMode: string;
}

export interface SettingsViewState {
  scope: SettingsScope;
  setScope: (scope: SettingsScope) => void;
  /** Project scope is only selectable when a project is active. */
  projectScopeEnabled: boolean;
  effective: EffectiveSettings;
  /** Patch the run-shaping fields, routed to the global block or the active
   *  project's override per the current scope. */
  patchScoped: (patch: SettingsPatch) => void;
}

export function useSettingsView({
  settings,
  activeProjectId,
  onUpdate,
}: Pick<
  SettingsViewProps,
  'settings' | 'activeProjectId' | 'onUpdate'
>): SettingsViewState {
  const projectScopeEnabled = activeProjectId !== null;
  const [scope, setScope] = useState<SettingsScope>('global');

  const effective = useMemo<EffectiveSettings>(() => {
    const override =
      scope === 'project' && activeProjectId !== null
        ? settings.projectOverrides[activeProjectId]
        : undefined;
    return {
      defaultModel: override?.defaultModel ?? settings.defaultModel,
      defaultEffort: override?.defaultEffort ?? settings.defaultEffort,
      maxConcurrency: override?.maxConcurrency ?? settings.maxConcurrency,
      permissionMode: override?.permissionMode ?? settings.permissionMode,
    };
  }, [scope, activeProjectId, settings]);

  const patchScoped = useCallback(
    (patch: SettingsPatch) => {
      if (scope === 'project' && activeProjectId !== null) {
        onUpdate({ ...patch, projectId: activeProjectId });
      } else {
        onUpdate(patch);
      }
    },
    [scope, activeProjectId, onUpdate],
  );

  return {
    scope,
    setScope,
    projectScopeEnabled,
    effective,
    patchScoped,
  };
}
