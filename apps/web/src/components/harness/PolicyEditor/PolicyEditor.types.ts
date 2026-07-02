/** Prop + draft types for the harness policy editor. */
import type { HarnessPolicyFile, HarnessPolicyPatch } from '@/lib/bridge';

/** Props for the policy editor card: the loaded policy (null while loading) and
 *  the save action owned by the PolicySection parent. */
export interface PolicyEditorProps {
  /** The active project's policy block, or `null` while it loads. */
  policy: HarnessPolicyFile | null;
  /** True while a save write is in flight. */
  saving: boolean;
  /** The error returned by the last save, or `null`. */
  saveError: string | null;
  /** Persist the patch to `.nightcore/harness.json` (merge-by-key). */
  onSave: (patch: HarnessPolicyPatch) => void;
}

/** The four editable string-list policy fields. */
export type PolicyListKey =
  | 'protectedPaths'
  | 'denyBashPatterns'
  | 'denyReadPaths'
  | 'disallowedTools';

/** The editor's working copy: lists as row arrays, diff-budget limits as raw
 *  input text (`''` = unset, so both inputs are clearable). */
export interface PolicyDraft {
  enabled: boolean;
  protectedPaths: string[];
  denyBashPatterns: string[];
  denyReadPaths: string[];
  disallowedTools: string[];
  maxChangedLines: string;
  maxChangedFiles: string;
}
