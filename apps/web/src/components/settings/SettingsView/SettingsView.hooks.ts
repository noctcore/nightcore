/** State for the Settings view: scope/page selection, effective values, and scoped patching. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type AppInfo,
  getAppInfo,
  type McpServerEntry,
  type RunMode,
  type SettingsPatch,
} from '@/lib/bridge';

import type {
  SettingsPage,
  SettingsScope,
  SettingsViewProps,
} from './SettingsView.types';

/** The run-shaping values currently in effect for the selected scope. Under the
 *  Project scope, a field falls back to the global value when the override is
 *  unset, so the controls always show what a run would actually use. */
export interface EffectiveSettings {
  defaultModel: string;
  defaultEffort: string;
  maxConcurrency: number;
  permissionMode: string;
  defaultRunMode: RunMode;
  /** SDK guardrail: the effective max-turns ceiling for the scope, or `null` when
   *  neither the scope override nor the global sets one (inherit the config 200). */
  maxTurns: number | null;
  /** SDK guardrail: the effective max-budget-USD ceiling, or `null` (uncapped). */
  maxBudgetUsd: number | null;
  /** The external MCP server list in effect for the scope: a project override
   *  REPLACES the global list wholesale (whole-list semantics, same as the Rust
   *  resolver), else the global list. Editing it sends the full next list. */
  mcpServers: McpServerEntry[];
  /** Whether the curated Constitution context pack is injected for the scope
   *  (project override, else the global toggle; defaults on). */
  contextPackEnabled: boolean;
}

/** The state and actions the Settings view binds to. */
export interface SettingsViewState {
  /** The selected settings page in the left nav. */
  page: SettingsPage;
  setPage: (page: SettingsPage) => void;
  scope: SettingsScope;
  setScope: (scope: SettingsScope) => void;
  /** Project scope is only selectable when a project is active. */
  projectScopeEnabled: boolean;
  effective: EffectiveSettings;
  /** Patch the run-shaping fields, routed to the global block or the active
   *  project's override per the current scope. */
  patchScoped: (patch: SettingsPatch) => void;
  /** Patch a global-only field (e.g. `cleanupWorktrees`, `notifyOnComplete`),
   *  never scoped to a project — those settings are global by design. */
  patchGlobal: (patch: SettingsPatch) => void;
}

/**
 * Owns the Settings view's local UI state (selected page and scope) and derives
 * the effective values for the scope, falling back from a project override to the
 * global value per field. Patches are routed global or per-project via `patchScoped`.
 */
export function useSettingsView({
  settings,
  activeProjectId,
  onUpdate,
}: Pick<
  SettingsViewProps,
  'settings' | 'activeProjectId' | 'onUpdate'
>): SettingsViewState {
  const projectScopeEnabled = activeProjectId !== null;
  const [page, setPage] = useState<SettingsPage>('models');
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
      defaultRunMode: override?.defaultRunMode ?? settings.defaultRunMode,
      maxTurns: override?.maxTurns ?? settings.maxTurns,
      maxBudgetUsd: override?.maxBudgetUsd ?? settings.maxBudgetUsd,
      // Whole-list replace: a project override owns its list entirely (mirrors the
      // Rust `enabled_mcp_servers` resolution); `?? []` keeps a legacy/absent list
      // empty so the card always renders.
      mcpServers: override?.mcpServers ?? settings.mcpServers ?? [],
      // Project override wins, else the global toggle (defaults on). `??` chains so
      // a `false` override is honored (only `null`/`undefined` falls back).
      contextPackEnabled:
        override?.contextPackEnabled ?? settings.contextPackEnabled ?? true,
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

  const patchGlobal = useCallback(
    (patch: SettingsPatch) => onUpdate(patch),
    [onUpdate],
  );

  return {
    page,
    setPage: useCallback((next: SettingsPage) => setPage(next), []),
    scope,
    setScope,
    projectScopeEnabled,
    effective,
    patchScoped,
    patchGlobal,
  };
}

/** Load the real app metadata (version + repo URL) for the About page once. Null
 *  until it resolves; the About card falls back to neutral text meanwhile. */
export function useAppInfo(): AppInfo | null {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    let alive = true;
    void getAppInfo()
      .then((loaded) => {
        if (alive) setInfo(loaded);
      })
      .catch((err) => {
        // Non-fatal: the About card falls back to neutral text. Log so the
        // rejection doesn't leak as an unhandled promise.
        console.error('app_info failed', err);
      });
    return () => {
      alive = false;
    };
  }, []);
  return info;
}
