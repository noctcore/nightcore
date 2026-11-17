import { describe, expect, test } from 'bun:test';

import * as rules from './rules.js';

/** One rule from every factory, built with the least config each accepts. */
function everyRule(): rules.IMetaRule[] {
  return [
    rules.createLockfileRegistryResolutionsRule(),
    rules.createSingleVersionDependenciesRule({ packages: ['typescript'] }),
    rules.createOnlyBuiltDependenciesHaveScriptsRule(),
    rules.createPnpmPatchLedgerRule(),
    rules.createGithubActionsSecretNoInstallRule(),
    rules.createGithubActionsSecurityNoCancelRule(),
  ];
}

describe('the rules subpath', () => {
  test('RULE_IDS lists every factory id once, in catalog order', () => {
    expect(everyRule().map((rule) => rule.id)).toEqual([...rules.RULE_IDS]);
    expect(new Set(rules.RULE_IDS).size).toBe(rules.RULE_IDS.length);
  });

  test('every rule is strict: CI-critical, a sync pass, no ratchet, a description', () => {
    for (const rule of everyRule()) {
      expect(rule.ciCritical).toBe(true);
      expect(typeof rule.run).toBe('function');
      expect(rule.baseline).toBeUndefined();
      expect(rule.description.trim().length).toBeGreaterThan(0);
      expect(['supply-chain', 'ci']).toContain(rule.category);
    }
  });
});
