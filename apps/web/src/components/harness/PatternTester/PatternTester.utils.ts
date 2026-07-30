/** The pattern tester's verdict computation (issue #400).
 *
 *  EVERY match here runs through `@nightcore/contracts`' policy matchers — the
 *  SAME compile + match core the engine's PreToolUse gate calls. There is
 *  deliberately no matching logic in this file: a tester that could disagree
 *  with enforcement would be worse than no tester, because it would certify a
 *  rule that does not actually hold. What this module owns is the TIER ORDER and
 *  the wording, mirroring `evaluateHarnessPolicy`:
 *
 *    disallowedTools → protected write paths → denied read paths →
 *    denyBashPatterns → askTools
 *
 *  Two deliberate simplifications, both stated in the UI copy rather than hidden:
 *  the path probes answer for the path-bearing tools of their channel (a
 *  `Write`/`Edit` target, a `Read`/`Grep` target), and out-of-repo targets are
 *  workspace confinement's jurisdiction, not the policy's. */
import {
  bashPatternMatches,
  compileBashPattern,
  compilePathRule,
  compileToolEntries,
  firstMatchingPathRule,
  MANIFEST_PROTECTED_PATTERN,
  toolMatches,
} from '@nightcore/contracts';

import type { PolicyProbeLists } from './PatternTester.types';

/** What the gate would decide. Mirrors the engine's verdict shape: a deny, an
 *  escalation to an interactive ask, or nothing (the common path). */
export type ProbeOutcome = 'denied' | 'ask' | 'allowed';

/** One probe's answer: the outcome, the tier that produced it, the exact pattern
 *  that matched (so the author can see WHICH of their rules fired), and the
 *  sentence the card renders. */
export interface ProbeVerdict {
  outcome: ProbeOutcome;
  /** The policy field responsible, or `null` when nothing matched. */
  tier: string | null;
  /** The matched entry verbatim, or `null` when nothing matched. */
  pattern: string | null;
  message: string;
}

const ALLOWED_WRITE: ProbeVerdict = {
  outcome: 'allowed',
  tier: null,
  pattern: null,
  message: 'No rule covers this path — an agent may write it.',
};

const ALLOWED_READ: ProbeVerdict = {
  outcome: 'allowed',
  tier: null,
  pattern: null,
  message: 'No rule covers this path — an agent may read it.',
};

const ALLOWED_COMMAND: ProbeVerdict = {
  outcome: 'allowed',
  tier: null,
  pattern: null,
  message: 'No denied pattern matches this command line.',
};

/** Compile a pattern list, dropping the entries the engine itself drops (empty
 *  ones), so the tester never reports a match from a rule the gate skips. */
function pathRules(patterns: readonly string[]) {
  return patterns
    .map((pattern) => compilePathRule(pattern))
    .filter((rule): rule is NonNullable<typeof rule> => rule !== undefined);
}

/**
 * Would a WRITE to `relativePath` be denied? The implicit self-protection
 * pattern is prepended exactly as `compileHarnessPolicy` does, so the tester
 * reports the rule the author never typed — `.nightcore/**` is protected
 * whenever the layer is armed, and an author who does not know that is surprised
 * at run time instead of here.
 */
export function probeWrite(
  lists: PolicyProbeLists,
  relativePath: string,
): ProbeVerdict {
  const trimmed = relativePath.trim();
  if (trimmed.length === 0) return ALLOWED_WRITE;
  const rules = pathRules([MANIFEST_PROTECTED_PATTERN, ...lists.protectedPaths]);
  const matched = firstMatchingPathRule(rules, trimmed);
  if (matched === undefined) return ALLOWED_WRITE;
  const implicit = matched.pattern === MANIFEST_PROTECTED_PATTERN;
  return {
    outcome: 'denied',
    tier: implicit ? 'implicit self-protection' : 'protectedPaths',
    pattern: matched.pattern,
    message: implicit
      ? 'Write denied by the implicit self-protection rule — the manifest that gates the agent is never agent-writable.'
      : 'Write denied — Write/Edit/MultiEdit/NotebookEdit on this path is blocked, even under bypass permissions.',
  };
}

/** Would a READ of `relativePath` be denied? No implicit entry here: reading the
 *  manifest is harmless, writing it is what self-protection stops. */
export function probeRead(
  lists: PolicyProbeLists,
  relativePath: string,
): ProbeVerdict {
  const trimmed = relativePath.trim();
  if (trimmed.length === 0) return ALLOWED_READ;
  const matched = firstMatchingPathRule(pathRules(lists.denyReadPaths), trimmed);
  if (matched === undefined) return ALLOWED_READ;
  return {
    outcome: 'denied',
    tier: 'denyReadPaths',
    pattern: matched.pattern,
    message:
      'Read denied — Read/NotebookRead, and Grep/Glob with this explicit path, are blocked.',
  };
}

/** Would this Bash command line be denied? Skips patterns the engine cannot
 *  compile (they enforce nothing), so the verdict matches the armed layer. */
export function probeCommand(lists: PolicyProbeLists, command: string): ProbeVerdict {
  if (command.trim().length === 0) return ALLOWED_COMMAND;
  for (const pattern of lists.denyBashPatterns) {
    const compiled = compileBashPattern(pattern);
    if (compiled.regex === undefined) continue;
    if (bashPatternMatches(compiled.regex, command)) {
      return {
        outcome: 'denied',
        tier: 'denyBashPatterns',
        pattern,
        message: 'Bash call denied — this command line matches a denied pattern.',
      };
    }
  }
  return ALLOWED_COMMAND;
}

/** Which tier gates this tool name? Deny is checked before ask, exactly as the
 *  gate does, so an entry in both lists reports the deny — never the softer ask. */
export function probeTool(lists: PolicyProbeLists, toolName: string): ProbeVerdict {
  const trimmed = toolName.trim();
  if (trimmed.length === 0) {
    return {
      outcome: 'allowed',
      tier: null,
      pattern: null,
      message: 'No tier gates this tool.',
    };
  }
  if (toolMatches(compileToolEntries(lists.disallowedTools), trimmed)) {
    return {
      outcome: 'denied',
      tier: 'disallowedTools',
      pattern: matchingEntry(lists.disallowedTools, trimmed),
      message: 'Denied outright — the agent cannot call this tool at all.',
    };
  }
  if (toolMatches(compileToolEntries(lists.askTools), trimmed)) {
    return {
      outcome: 'ask',
      tier: 'askTools',
      pattern: matchingEntry(lists.askTools, trimmed),
      message: 'Escalated to an interactive approval on every call, even under bypass permissions.',
    };
  }
  return {
    outcome: 'allowed',
    tier: null,
    pattern: null,
    message: 'No tier gates this tool — the agent may call it.',
  };
}

/** The specific list entry that gated `toolName`, for attribution. Re-runs the
 *  shared matcher one entry at a time rather than re-deriving its rules. */
function matchingEntry(entries: readonly string[], toolName: string): string | null {
  return (
    entries.find((entry) => toolMatches(compileToolEntries([entry]), toolName)) ?? null
  );
}
