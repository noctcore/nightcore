// @ts-check
import type { IMetaRule, IViolation } from '../types';

/**
 * `no-cloned-component-folders` (issue #54) — same-named component folders
 * across features are how scan-sibling drift happens: a component cloned into
 * a second feature diverges silently (today's `RunControls` exists ×3,
 * content-diverged). A shared surface belongs in `components/ui` (the house
 * pattern: RunLifecycleShell / CategoryTabsShell); a genuinely different one
 * deserves a name that says so.
 *
 * ALLOWED_CLONES freezes exactly today's clone groups — the allowlist IS the
 * ratchet. The web-struct refactors shrink it (hoist or rename); an entry may
 * be re-added only for clones whose semantics genuinely differ per feature.
 */

const WEB_COMPONENTS = 'apps/web/src/components';

/** Feature folders whose contents are not feature components. */
const EXCLUDED_FEATURES = new Set(['ui', 'app']);

/**
 * Today's clone groups, frozen. Shrink me (issues web-struct 2/8 + 3/8):
 *  - `RunControls` ×3 (insight/harness/scorecard) — hoist to components/ui;
 *  - `CategoryTabs` ×2 — converge on the CategoryTabsShell primitive;
 *  - `FindingDetailPanel` ×2 — may earn a permanent entry or a rename
 *    (insight vs prreview findings genuinely differ).
 */
const ALLOWED_CLONES = new Set(['RunControls', 'CategoryTabs', 'FindingDetailPanel']);

export const noClonedComponentFoldersRule: IMetaRule = {
  id: 'no-cloned-component-folders',
  category: 'source-text',
  ciCritical: true,
  description:
    'A component folder name may exist under only ONE feature (ui/app excluded). Shared surfaces are hoisted to components/ui; divergent ones get a divergent name. Today’s clones are frozen in ALLOWED_CLONES — a shrinking allowlist.',
  run(ctx) {
    const violations: IViolation[] = [];

    // <feature>/<Name>/index.ts marks a component folder.
    const byName = new Map<string, string[]>();
    for (const rel of ctx.glob(`${WEB_COMPONENTS}/*/*/index.ts`)) {
      const segments = rel.split('/');
      const name = segments[segments.length - 2] ?? '';
      const feature = segments[segments.length - 3] ?? '';
      if (EXCLUDED_FEATURES.has(feature)) continue;
      const features = byName.get(name) ?? [];
      features.push(feature);
      byName.set(name, features);
    }

    for (const [name, features] of byName) {
      if (features.length < 2 || ALLOWED_CLONES.has(name)) continue;
      violations.push({
        file: `${WEB_COMPONENTS}/{${features.sort().join(',')}}/${name}`,
        rule: 'no-cloned-component-folders',
        message: `Component folder '${name}' is cloned across ${features.length} features (${features.sort().join(', ')}) — clone drift in the making. Hoist it to components/ui (like RunLifecycleShell/CategoryTabsShell) or rename to reflect divergent semantics.`,
      });
    }

    // Self-tightening: an allowlist entry with no clone group left is stale.
    for (const name of ALLOWED_CLONES) {
      const features = byName.get(name) ?? [];
      if (features.length < 2) {
        violations.push({
          file: `${WEB_COMPONENTS}/*/${name}`,
          rule: 'no-cloned-component-folders',
          message: `ALLOWED_CLONES entry '${name}' is stale — the clone group no longer exists. Remove it from tools/lint-meta/rules/no-cloned-component-folders.ts (the allowlist only shrinks).`,
        });
      }
    }

    return violations;
  },
};
