/** Policy-file load/save/quarantine state for the Policy section. */
import { useCallback, useEffect, useState } from 'react';

import { useToast } from '@/components/ui';
import {
  getHarnessPolicyFile,
  type HarnessPolicyFile,
  type HarnessPolicyPatch,
  listHarnessRuns,
  type StoredRepoProfile,
  updateHarnessPolicyFile,
} from '@/lib/bridge';

import type { PolicyProfileHints } from '../PolicyStarterPacks';

/** denyReadPaths with `path` appended, or `null` when it is already present
 *  (the dedupe rule: quarantining twice must not grow the list). */
export function appendQuarantinePath(existing: string[], path: string): string[] | null {
  if (existing.includes(path)) return null;
  return [...existing, path];
}

/** Narrow a persisted Harness profile to the fields the starter packs key on.
 *  Deliberately lossy: a pack predicate reads three fields, so nothing else from
 *  a scan artifact can influence which rails are offered. */
export function profileHints(profile: StoredRepoProfile): PolicyProfileHints {
  return {
    isMonorepo: profile.isMonorepo,
    languages: profile.languages,
    frameworks: profile.frameworks,
  };
}

/** Everything the PolicySection shell renders. */
export interface PolicySectionVM {
  /** The authoritative policy (re-read from disk after every write), or `null`
   *  while the initial load is in flight. */
  policy: HarnessPolicyFile | null;
  /** Repo shape from the newest Harness run, keying the starter packs; `null`
   *  until it loads, or when the project has never been scanned. */
  profile: PolicyProfileHints | null;
  loadError: string | null;
  saving: boolean;
  saveError: string | null;
  /** Persist an editor patch and adopt the re-read policy. */
  save: (patch: HarnessPolicyPatch) => void;
  /** Append a flagged path to denyReadPaths (deduped) and adopt the re-read
   *  policy. Already-quarantined paths are a no-op. */
  quarantine: (path: string) => Promise<void>;
}

/** Own the policy file for both cards: one authoritative `HarnessPolicyFile`
 *  that every write (editor save, scan quarantine) replaces with the command's
 *  re-read result — so the editor baseline and the scan rows never drift from
 *  what's on disk. */
export function usePolicySection(): PolicySectionVM {
  const [policy, setPolicy] = useState<HarnessPolicyFile | null>(null);
  const [profile, setProfile] = useState<PolicyProfileHints | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await getHarnessPolicyFile();
        if (!cancelled) setPolicy(loaded);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
        }
      }
      // The repo profile only keys which starter packs are OFFERED, so its
      // failure is never surfaced: a project with no scan (or an unreadable run)
      // simply gets the universal packs.
      try {
        const runs = await listHarnessRuns();
        const newest = runs[0];
        if (!cancelled && newest !== undefined) setProfile(profileHints(newest.profile));
      } catch {
        // Intentionally ignored — see above.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    (patch: HarnessPolicyPatch) => {
      setSaving(true);
      setSaveError(null);
      void (async () => {
        try {
          const next = await updateHarnessPolicyFile(patch);
          setPolicy(next);
          toast.push({
            tone: 'success',
            title: 'Policy saved',
            description: 'Runtime enforcement follows .nightcore/harness.json on the next session.',
          });
        } catch (err) {
          // Inline (not just a toast): the editor keeps its dirty draft, so the
          // user sees exactly why the save didn't land next to the Save button.
          setSaveError(err instanceof Error ? err.message : String(err));
        } finally {
          setSaving(false);
        }
      })();
    },
    [toast],
  );

  const quarantine = useCallback(
    async (path: string) => {
      const current = policy?.denyReadPaths ?? [];
      const next = appendQuarantinePath(current, path);
      if (next === null) return; // already quarantined — nothing to write
      try {
        const updated = await updateHarnessPolicyFile({
          enabled: null,
          protectedPaths: null,
          denyBashPatterns: null,
          denyReadPaths: next,
          disallowedTools: null,
          askTools: null,
          allowTools: null,
          diffBudget: null,
        });
        setPolicy(updated);
        toast.push({
          tone: 'success',
          title: 'Path quarantined',
          description: `Agents can no longer read ${path}.`,
        });
      } catch (err) {
        toast.error('Could not quarantine path', err);
      }
    },
    [policy, toast],
  );

  return { policy, profile, loadError, saving, saveError, save, quarantine };
}
