// @ts-check
import type { IMetaRule, IViolation } from '../types';

/**
 * components/ui is the one folder exempt from folder-per-component: shadcn-style
 * primitives may be flat single .tsx files. But once a primitive graduates to a
 * folder (its own dir + index.ts barrel) it is a real component and must ship
 * the same proof-of-behavior siblings as any feature component: `<Name>.test.tsx`
 * and `<Name>.stories.tsx`. This closes the "ui mixes two folder shapes with no
 * rule" gap — flat = pure presentational; folder = tested + storied.
 *
 * Every ui folder-primitive carries an index.ts barrel, so glob those to
 * enumerate folders, then require the two siblings named after the folder (the
 * entry-file basename convention). Also flags the hybrid shape: a flat
 * `<Name>.tsx` at the ui root that already has sibling `<Name>.test.tsx` or
 * `<Name>.stories.tsx` — those proof files belong inside `<Name>/`.
 */
const UI_ROOT = 'apps/web/src/components/ui';

export const uiPrimitiveShapeRule: IMetaRule = {
  id: 'ui-primitive-shape',
  category: 'source-text',
  ciCritical: true,
  description:
    'A components/ui primitive that is a folder must ship <Name>.test.tsx and <Name>.stories.tsx; flat .tsx files must not carry sibling test/story files at the ui root.',
  run(ctx) {
    const violations: IViolation[] = [];
    for (const barrel of ctx.glob(`${UI_ROOT}/*/index.ts`)) {
      const dir = barrel.replace(/\/index\.ts$/, '');
      const name = dir.split('/').pop() ?? dir;
      for (const role of ['test', 'stories'] as const) {
        const rel = `${dir}/${name}.${role}.tsx`;
        if (!ctx.exists(rel)) {
          violations.push({
            file: dir,
            rule: 'ui-primitive-shape',
            message: `ui folder-primitive '${name}' is missing ${name}.${role}.tsx. A ui primitive complex enough to be a folder must ship a test and a story (or stay a flat presentational .tsx).`,
          });
        }
      }
    }
    for (const flat of ctx.glob(`${UI_ROOT}/[A-Z]*.tsx`)) {
      const name = flat.split('/').pop()?.replace(/\.tsx$/, '') ?? flat;
      for (const role of ['test', 'stories'] as const) {
        const sibling = `${UI_ROOT}/${name}.${role}.tsx`;
        if (ctx.exists(sibling)) {
          violations.push({
            file: flat,
            rule: 'ui-primitive-shape',
            message: `ui flat primitive '${name}.tsx' has a sibling ${name}.${role}.tsx at the ui root — move both into a '${name}/' folder with index.ts.`,
          });
        }
      }
    }
    return violations;
  },
};
