/**
 * Compile-time guards on the published rule contract. The assertions below fail
 * `tsc` (check-types), not a test run; the runtime test only keeps the file
 * enrolled and proves the objects are real rules.
 */
import { describe, expect, test } from 'bun:test';

import { isMetaRule } from './registry.js';
import type { IMetaCtx, IMetaRule, IViolation } from './types.js';

/** A consumer's richer ctx, the way Settly's `IMetaContext` extends the harness one. */
interface IRicherCtx extends IMetaCtx {
  readonly sourceFiles: readonly string[];
}

/** A consumer-side rule contract with both entry points optional (Settly's shape). */
interface IConsumerRule {
  readonly id: string;
  readonly category: IMetaRule['category'];
  readonly description: string;
  readonly ciCritical?: boolean;
  run?: (ctx: IRicherCtx) => IViolation[];
  runAsync?: (ctx: IRicherCtx) => Promise<IViolation[]>;
}

type Assert<T extends true> = T;

/** A consumer's rule loads into the harness contract unchanged... */
export type ConsumerRuleIsHarnessRule = Assert<IConsumerRule extends IMetaRule ? true : never>;
/** ...and a harness rule adopts into the consumer's contract. */
export type HarnessRuleIsConsumerRule = Assert<IMetaRule extends IConsumerRule ? true : never>;

/** 0.2.0 accepted a `run` typed against a richer ctx (method bivariance); 0.3.0 still must. */
const richerSync: IMetaRule = {
  id: 'richer-sync',
  category: 'source-text',
  description: 'reads a field only the consumer ctx has',
  run: (ctx: IRicherCtx) => (ctx.sourceFiles.length > 0 ? [] : []),
};

/** The async-only shape: `runAsync({ root })`, no `run`. */
const asyncOnly: IMetaRule = {
  id: 'async-only',
  category: 'config',
  description: 'needs an async API',
  runAsync({ root }: IMetaCtx): Promise<IViolation[]> {
    return Promise.resolve(root === '' ? [] : []);
  },
};

describe('IMetaRule contract', () => {
  test('both compile-time shapes are loadable rules at runtime', () => {
    expect(isMetaRule(richerSync)).toBe(true);
    expect(isMetaRule(asyncOnly)).toBe(true);
  });
});
