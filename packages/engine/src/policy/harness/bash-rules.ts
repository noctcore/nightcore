/**
 * Compile + match `denyBashPatterns` — the harness policy gate's Bash
 * deny-pattern tier (`../harness-policy.ts`). Patterns are project-authored
 * regexes matched against the RAW command line, case-sensitive (predictable
 * for pattern authors); an invalid regex is warn-and-skipped at compile so one
 * typo never bricks the layer. Both the pattern length and the scanned command
 * length are capped as a catastrophic-backtracking mitigation — the sidecar is
 * a single process, so one pathological `RegExp.test` stalls every session.
 */
import type { Logger } from '@nightcore/shared';

/** Max length of one `denyBashPatterns` regex; longer patterns are
 *  warn-and-skipped at compile (same path as an invalid regex). Caps the
 *  pattern half of the catastrophic-backtracking surface. */
export const MAX_BASH_PATTERN_LENGTH = 512;

/** Only this many chars of a Bash command are tested against the deny
 *  patterns — the input half of the backtracking mitigation. A >16 KiB command
 *  is already pathological; a deny pattern that would only match PAST the cap
 *  fails open, which is acceptable for a heuristic gate (the destructive deny
 *  list and the OS-sandbox roadmap remain the hard lines). */
export const BASH_COMMAND_SCAN_LIMIT = 16 * 1024;

/** One compiled Bash deny rule: the original pattern text + its regex. */
export interface CompiledBashRule {
  pattern: string;
  regex: RegExp;
}

/**
 * Compile `denyBashPatterns` into regexes. An oversized or invalid pattern is
 * warn-and-skipped (one typo must never brick the layer) — the remaining
 * rules still enforce.
 */
export function compileBashRules(
  patterns: readonly string[],
  logger?: Logger,
): CompiledBashRule[] {
  const bashRules: CompiledBashRule[] = [];
  for (const pattern of patterns) {
    // Length cap before compile: a very long project-authored pattern is the
    // easiest way to smuggle in catastrophic backtracking. Same warn-and-skip
    // posture as an invalid regex — the remaining rules still enforce.
    if (pattern.length > MAX_BASH_PATTERN_LENGTH) {
      logger?.warn('skipping oversized harness denyBashPatterns regex', {
        pattern: pattern.slice(0, 64),
        length: pattern.length,
        max: MAX_BASH_PATTERN_LENGTH,
      });
      continue;
    }
    try {
      bashRules.push({ pattern, regex: new RegExp(pattern) });
    } catch (error) {
      logger?.warn('skipping invalid harness denyBashPatterns regex', {
        pattern,
        error,
      });
    }
  }
  return bashRules;
}

/**
 * Match a Bash command against the compiled deny rules, returning the first
 * matching rule or undefined. `command` is truncated to
 * {@link BASH_COMMAND_SCAN_LIMIT} before testing (the input half of the
 * backtracking mitigation, see the module header).
 */
export function matchBashRule(
  command: string,
  rules: readonly CompiledBashRule[],
): CompiledBashRule | undefined {
  const bounded =
    command.length > BASH_COMMAND_SCAN_LIMIT
      ? command.slice(0, BASH_COMMAND_SCAN_LIMIT)
      : command;
  return rules.find((rule) => rule.regex.test(bounded));
}
