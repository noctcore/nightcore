/** Prop + probe types for the policy pattern tester. */

/** The policy tiers the tester probes, as the DRAFT holds them — the tester
 *  answers "would the rule I am typing right now fire?", so it reads the unsaved
 *  draft, not the file on disk. */
export interface PolicyProbeLists {
  protectedPaths: readonly string[];
  denyReadPaths: readonly string[];
  denyBashPatterns: readonly string[];
  disallowedTools: readonly string[];
  askTools: readonly string[];
}

/** Props for {@link import('./PatternTester').PatternTester}. One grouped object:
 *  the tester never mutates the policy, it only evaluates it. */
export interface PatternTesterProps {
  lists: PolicyProbeLists;
}
