/**
 * Compile + match `denyBashPatterns` — the harness policy gate's Bash
 * deny-pattern tier (`../harness-policy.ts`). Patterns are project-authored
 * regexes matched against the RAW command line, case-sensitive (predictable
 * for pattern authors); an invalid regex is warn-and-skipped at compile so one
 * typo never bricks the layer. Both the pattern length and the scanned command
 * length are capped as a catastrophic-backtracking mitigation — the sidecar is
 * a single process, so one pathological `RegExp.test` stalls every session.
 *
 * The single-pattern compile + the bounded test moved to `@nightcore/contracts`
 * (`policy-patterns.ts`, issue #400) so the web policy editor validates and
 * tests patterns through the EXACT code that enforces them; this module keeps
 * the list-level orchestration and the operator-facing WARN log, which a
 * contract-rank module has no logger for.
 */
import {
  BASH_COMMAND_SCAN_LIMIT,
  bashPatternMatches,
  compileBashPattern,
  MAX_BASH_PATTERN_LENGTH,
} from '@nightcore/contracts';
import type { Logger } from '@nightcore/shared';

export { BASH_COMMAND_SCAN_LIMIT, MAX_BASH_PATTERN_LENGTH };

/** One compiled Bash deny rule: the original pattern text + its regex. */
export interface CompiledBashRule {
  pattern: string;
  regex: RegExp;
}

/**
 * Compile `denyBashPatterns` into regexes. An oversized or invalid pattern is
 * warn-and-skipped (one typo must never brick the layer) — the remaining
 * rules still enforce. Both refusals come from the shared
 * {@link compileBashPattern}, so the reason logged here is the reason the policy
 * editor shows inline.
 */
export function compileBashRules(
  patterns: readonly string[],
  logger?: Logger,
): CompiledBashRule[] {
  const bashRules: CompiledBashRule[] = [];
  for (const pattern of patterns) {
    const compiled = compileBashPattern(pattern);
    if (compiled.regex === undefined) {
      logger?.warn('skipping unusable harness denyBashPatterns regex', {
        pattern: pattern.slice(0, 64),
        length: pattern.length,
        error: compiled.error,
      });
      continue;
    }
    bashRules.push({ pattern, regex: compiled.regex });
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
  return rules.find((rule) => bashPatternMatches(rule.regex, command));
}
