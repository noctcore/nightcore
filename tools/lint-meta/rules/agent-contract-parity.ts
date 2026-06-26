// @ts-check
import type { IMetaRule } from '../types';

/**
 * Contract parity: the agent-read-first AGENTS.md docs must mention every
 * `nightcore/*` lint rule that is wired (registered in the plugin's recommended
 * config). If a guardrail is dropped from the docs but still enforced, an agent
 * would work from a stale contract — so CI fails until the doc is updated.
 */
export const agentContractParityRule: IMetaRule = {
  id: 'agent-contract-parity',
  category: 'source-text',
  ciCritical: true,
  description:
    'Every wired nightcore/* lint rule must be documented as a guardrail in an AGENTS.md contract doc.',
  run(ctx) {
    const recommended = ctx.read(
      'packages/eslint-plugin/src/configs/recommended.ts',
    );
    if (recommended === null) return [];
    const ruleNames = Array.from(
      recommended.matchAll(/'nightcore\/([a-z0-9-]+)'/g),
      (m) => m[1],
    );
    // Bun's Glob does not support `{a,b,c}` brace alternation across mixed
    // depths (the combined pattern silently returns []), so glob each doc
    // location separately and merge the matches.
    const docs = ['AGENTS.md', 'apps/*/AGENTS.md', 'packages/*/AGENTS.md']
      .flatMap((pattern) => ctx.glob(pattern))
      .map((rel) => ctx.read(rel) ?? '')
      .join('\n');
    const violations = [];
    for (const name of new Set(ruleNames)) {
      if (!docs.includes(name)) {
        violations.push({
          file: 'AGENTS.md',
          rule: 'agent-contract-parity',
          message: `Lint rule 'nightcore/${name}' is wired but not documented in any AGENTS.md guardrail doc. Document it (or remove the rule).`,
        });
      }
    }
    return violations;
  },
};
