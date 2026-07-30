/** Pure authoring helpers for the harness policy editor: the per-tier field table
 *  and the edit-time diagnostics that decide whether a draft may be saved
 *  (issue #400).
 *
 *  The diagnostics themselves come from `@nightcore/contracts` — the SAME module
 *  the engine's compile wrappers use — so a rule the editor calls dead is exactly
 *  a rule the gate skips. This file only decides WHICH tier each field belongs
 *  to, skips rows that are merely blank, and adds the one cross-field check
 *  (`askTools` shadowed by `disallowedTools`) that no single entry can see. */
import {
  compileToolEntries,
  diagnosePolicyEntry,
  type PolicyEntryDiagnostic,
  type PolicyEntryKind,
  toolMatches,
} from '@nightcore/contracts';

import type { PolicyDraft, PolicyListKey } from './PolicyEditor.types';

/** One list field's per-row metadata: the visible label, its one-line meaning,
 *  and the matching tier its entries are diagnosed against. */
export interface PolicyListField {
  key: PolicyListKey;
  label: string;
  hint: string;
  placeholder: string;
  /** Which matcher the engine evaluates this field's entries with — selects the
   *  diagnostic rules, so a glob typed into the regex tier gets the regex advice. */
  entryKind: PolicyEntryKind;
}

/** The editable list fields, in render order. */
export const POLICY_LIST_FIELDS: readonly PolicyListField[] = [
  {
    key: 'protectedPaths',
    label: 'Protected paths',
    hint: 'Globs agents may never write.',
    placeholder: 'migrations/**',
    entryKind: 'path',
  },
  {
    key: 'denyBashPatterns',
    label: 'Denied bash patterns',
    hint: 'JS regexes matched against the raw bash command line.',
    placeholder: '--no-verify',
    entryKind: 'bash-regex',
  },
  {
    key: 'denyReadPaths',
    label: 'Denied read paths',
    hint: 'Globs agents may never read — the quarantine list for injection-flagged files.',
    placeholder: '.env*',
    entryKind: 'path',
  },
  {
    key: 'disallowedTools',
    label: 'Disallowed tools',
    hint: 'Tool names removed from the agent entirely.',
    placeholder: 'WebSearch',
    entryKind: 'tool',
  },
  {
    key: 'askTools',
    label: 'Ask-first tools',
    hint: 'Tool names that require your interactive approval on every call, even in bypass mode.',
    placeholder: 'WebFetch',
    entryKind: 'tool',
  },
  {
    key: 'allowTools',
    label: 'Auto-allowed rules',
    hint: 'SDK permission rules approved without prompting (never overrides a deny).',
    placeholder: 'Bash(git status:*)',
    entryKind: 'permission-rule',
  },
] as const;

/** Per-field, per-row diagnostics — index-aligned with the draft's list rows so
 *  a row renders its own message. `null` = that row is fine (or blank). */
export type PolicyEntryIssues = Record<PolicyListKey, (PolicyEntryDiagnostic | null)[]>;

/**
 * Diagnose every row of a draft.
 *
 * A BLANK row is deliberately never flagged: `cleanList` drops empty rows at
 * save, so a freshly added row is "nothing yet", not a dead rule — flagging it
 * would put an error on screen for every click of Add.
 */
export function policyEntryIssues(draft: PolicyDraft): PolicyEntryIssues {
  // Deny wins over ask, so an askTools entry the deny tier already gates is dead
  // config (the engine logs the same fact at compile). Needs both lists, so it
  // cannot live in a per-entry diagnostic.
  const denyMatcher = compileToolEntries(draft.disallowedTools);
  const issues = {} as PolicyEntryIssues;
  for (const field of POLICY_LIST_FIELDS) {
    issues[field.key] = draft[field.key].map((raw) => {
      if (raw.trim().length === 0) return null;
      const diagnostic = diagnosePolicyEntry(field.entryKind, raw);
      if (diagnostic !== null) return diagnostic;
      if (field.key === 'askTools' && toolMatches(denyMatcher, raw.trim())) {
        return {
          severity: 'warning',
          message:
            'Also in Disallowed tools, where deny wins — this ask entry never fires. Remove it from one list.',
        };
      }
      return null;
    });
  }
  return issues;
}

/** How many rows are provably dead (`error`). Non-zero blocks Save: saving a
 *  rule that can never match is how a policy silently stops protecting. */
export function blockingIssueCount(issues: PolicyEntryIssues): number {
  return Object.values(issues)
    .flat()
    .filter((issue) => issue?.severity === 'error').length;
}

/** Merge a starter pack's entries into a draft list: appended in order, skipping
 *  anything already present (trim-insensitively) so applying a pack twice is a
 *  no-op and never duplicates a rule the author already wrote. */
export function mergeEntries(existing: string[], added: readonly string[]): string[] {
  const seen = new Set(existing.map((value) => value.trim()));
  const merged = [...existing];
  for (const entry of added) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged;
}
