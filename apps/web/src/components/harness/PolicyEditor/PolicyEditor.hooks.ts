/** Draft state + patch assembly for the harness policy editor. */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { HarnessPolicyFile, HarnessPolicyPatch } from '@/lib/bridge';

import type { PolicyDraft, PolicyEditorProps, PolicyListKey } from './PolicyEditor.types';

/** The editor's working copy of a loaded policy: lists copied as rows, the
 *  diff-budget limits stringified for the clearable numeric inputs. */
export function draftFromPolicy(policy: HarnessPolicyFile): PolicyDraft {
  return {
    enabled: policy.enabled,
    protectedPaths: [...policy.protectedPaths],
    denyBashPatterns: [...policy.denyBashPatterns],
    denyReadPaths: [...policy.denyReadPaths],
    disallowedTools: [...policy.disallowedTools],
    askTools: [...policy.askTools],
    allowTools: [...policy.allowTools],
    maxChangedLines: policy.diffBudget?.maxChangedLines?.toString() ?? '',
    maxChangedFiles: policy.diffBudget?.maxChangedFiles?.toString() ?? '',
  };
}

/** Normalize a list for persistence: trim rows, drop empties, dedupe (first
 *  occurrence wins) — so a blank add-row or a repeated glob never lands on disk. */
export function cleanList(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/** Validate a diff-budget limit input: empty is "unset" (valid); anything else
 *  must be a whole number ≥ 1. Returns the inline error, or `null` when valid. */
export function limitError(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) return 'Enter a whole number of 1 or more.';
  return null;
}

/** A validated limit input as its wire value: `''` ⇒ `null` (unset). Only call
 *  after {@link limitError} returned `null`. */
function limitValue(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : Number(trimmed);
}

/** Assemble the full merge-by-key patch from a valid draft. Every KNOWN policy
 *  key is sent (this is the whole-policy editor); unknown keys in the manifest
 *  survive because the Rust writer only touches the keys present here. */
export function buildPolicyPatch(draft: PolicyDraft): HarnessPolicyPatch {
  return {
    enabled: draft.enabled,
    protectedPaths: cleanList(draft.protectedPaths),
    denyBashPatterns: cleanList(draft.denyBashPatterns),
    denyReadPaths: cleanList(draft.denyReadPaths),
    disallowedTools: cleanList(draft.disallowedTools),
    askTools: cleanList(draft.askTools),
    allowTools: cleanList(draft.allowTools),
    diffBudget: {
      maxChangedLines: limitValue(draft.maxChangedLines),
      maxChangedFiles: limitValue(draft.maxChangedFiles),
    },
  };
}

/** Everything the PolicyEditor shell renders. */
export interface PolicyEditorVM {
  /** Whether the policy has loaded (renders a skeleton until then). */
  ready: boolean;
  /** Whether `.nightcore/harness.json` already exists (save edits vs. creates). */
  manifestExists: boolean;
  draft: PolicyDraft | null;
  /** True when the draft differs from the loaded policy. */
  dirty: boolean;
  /** Per-limit inline validation errors (block save while present). */
  limitErrors: { maxChangedLines: string | null; maxChangedFiles: string | null };
  canSave: boolean;
  saving: boolean;
  saveError: string | null;
  toggleEnabled: () => void;
  setListItem: (key: PolicyListKey, index: number, value: string) => void;
  addListItem: (key: PolicyListKey) => void;
  removeListItem: (key: PolicyListKey, index: number) => void;
  setLimit: (key: 'maxChangedLines' | 'maxChangedFiles', value: string) => void;
  save: () => void;
}

/** Own the editor draft: seeded from the loaded policy, reset whenever the
 *  policy reloads (a save or a quarantine returns the authoritative file — the
 *  draft re-seeds from it), with dirty tracking against that baseline. */
export function usePolicyEditor({
  policy,
  saving,
  saveError,
  onSave,
}: PolicyEditorProps): PolicyEditorVM {
  const [draft, setDraft] = useState<PolicyDraft | null>(
    policy === null ? null : draftFromPolicy(policy),
  );

  // Re-seed on every policy identity change: the parent only swaps the policy
  // object after an authoritative disk read (load / save / quarantine), so the
  // baseline — and any stale draft — must follow it.
  useEffect(() => {
    setDraft(policy === null ? null : draftFromPolicy(policy));
  }, [policy]);

  const dirty = useMemo(() => {
    if (policy === null || draft === null) return false;
    return JSON.stringify(draft) !== JSON.stringify(draftFromPolicy(policy));
  }, [policy, draft]);

  const limitErrors = useMemo(
    () => ({
      maxChangedLines: draft === null ? null : limitError(draft.maxChangedLines),
      maxChangedFiles: draft === null ? null : limitError(draft.maxChangedFiles),
    }),
    [draft],
  );

  const toggleEnabled = useCallback(() => {
    setDraft((prev) => (prev === null ? prev : { ...prev, enabled: !prev.enabled }));
  }, []);

  const setListItem = useCallback((key: PolicyListKey, index: number, value: string) => {
    setDraft((prev) => {
      if (prev === null) return prev;
      const list = [...prev[key]];
      list[index] = value;
      return { ...prev, [key]: list };
    });
  }, []);

  const addListItem = useCallback((key: PolicyListKey) => {
    setDraft((prev) => (prev === null ? prev : { ...prev, [key]: [...prev[key], ''] }));
  }, []);

  const removeListItem = useCallback((key: PolicyListKey, index: number) => {
    setDraft((prev) => {
      if (prev === null) return prev;
      return { ...prev, [key]: prev[key].filter((_, i) => i !== index) };
    });
  }, []);

  const setLimit = useCallback(
    (key: 'maxChangedLines' | 'maxChangedFiles', value: string) => {
      setDraft((prev) => (prev === null ? prev : { ...prev, [key]: value }));
    },
    [],
  );

  const canSave =
    draft !== null &&
    dirty &&
    !saving &&
    limitErrors.maxChangedLines === null &&
    limitErrors.maxChangedFiles === null;

  const save = useCallback(() => {
    if (draft === null) return;
    onSave(buildPolicyPatch(draft));
  }, [draft, onSave]);

  return {
    ready: policy !== null && draft !== null,
    manifestExists: policy?.manifestExists ?? true,
    draft,
    dirty,
    limitErrors,
    canSave,
    saving,
    saveError,
    toggleEnabled,
    setListItem,
    addListItem,
    removeListItem,
    setLimit,
    save,
  };
}
