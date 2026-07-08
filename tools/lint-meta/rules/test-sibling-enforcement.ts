// @ts-check
import type { IMetaRule, IViolation } from '../types';

/**
 * Every `<base>.utils.ts` (pure helper sidecar) under apps/web/src must have a
 * colocated sibling test: `<base>.utils.test.ts` or `<base>.utils.test.tsx`.
 * Modelled directly on ui-primitive-shape. Strict (no baseline); the pattern
 * is opt-in via creating the .utils.ts .
 */
const WEB_SRC = 'apps/web/src';

export const testSiblingEnforcementRule: IMetaRule = {
  id: 'test-sibling-enforcement',
  category: 'source-text',
  ciCritical: true,
  description:
    'Every <base>.utils.ts under apps/web/src must have sibling <base>.utils.test.ts(x).',
  run(ctx) {
    const violations: IViolation[] = [];
    for (const util of ctx.glob(`${WEB_SRC}/**/*.utils.ts`)) {
      const dir = util.replace(/\/[^/]+\.utils\.ts$/, '');
      const base = util.split('/').pop()?.replace(/\.utils\.ts$/, '') ?? '';
      const testTs = `${dir}/${base}.utils.test.ts`;
      const testTsx = `${dir}/${base}.utils.test.tsx`;
      if (!ctx.exists(testTs) && !ctx.exists(testTsx)) {
        violations.push({
          file: util,
          rule: 'test-sibling-enforcement',
          message: `utils file '${base}.utils.ts' is missing sibling ${base}.utils.test.ts(x). Pure helpers must ship a colocated test.`,
        });
      }
    }
    return violations;
  },
};
