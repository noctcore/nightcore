// @ts-check
// Enforcement implementation detail (not core agent contract prose).
import type { IMetaRule, IViolation } from '../types';

/**
 * Nav render parity (the blank-screen tripwire): every stage `view` the
 * `source-ref.ts` REGISTRY routes a provenance token to MUST have a matching
 * `view === '<x>'` render branch in `AppShellViews.tsx`.
 *
 * The `sourceRef` compat shim (Phase-1 stage flip) routes a task's persisted
 * provenance token through the REGISTRY → `setView(target.view)`. If a REGISTRY
 * entry points at a `view` with no render branch, the shell renders NOTHING — a
 * silent blank screen that TypeScript can't catch (the `view` string is a valid
 * `AppView`, it just isn't handled). This rule converts that failure mode into a
 * CI-red: it reads the two files, extracts the REGISTRY `view:` values and the
 * `AppShellViews` render branches, and asserts the former is a subset of the
 * latter. Pure file reads — no exec, no glob.
 */

const SOURCE_REF = 'apps/web/src/lib/source-ref.ts';
const APP_SHELL_VIEWS =
  'apps/web/src/components/app/AppShell/AppShellViews.tsx';

/** REGISTRY entry destinations: `view: 'understand'` → `understand`. */
const REGISTRY_VIEW = /view:\s*'([a-z]+)'/g;
/** Render-branch guards: `view === 'understand'` → `understand`. */
const RENDER_BRANCH = /view === '([a-z]+)'/g;

function captures(source: string, pattern: RegExp): Set<string> {
  return new Set(Array.from(source.matchAll(pattern), (m) => m[1] ?? ''));
}

export const navRenderParityRule: IMetaRule = {
  id: 'nav-render-parity',
  category: 'source-text',
  ciCritical: true,
  description:
    'Every source-ref REGISTRY view must have a matching render branch in AppShellViews.tsx (no silent blank screen).',
  run(ctx) {
    const registry = ctx.read(SOURCE_REF);
    const views = ctx.read(APP_SHELL_VIEWS);
    // If either file moved, that's a bigger break other rules will surface; stay
    // silent here rather than emit a misleading parity violation.
    if (registry === null || views === null) return [];

    const registryViews = captures(registry, REGISTRY_VIEW);
    const renderBranches = captures(views, RENDER_BRANCH);

    const violations: IViolation[] = [];
    for (const view of registryViews) {
      if (!renderBranches.has(view)) {
        violations.push({
          file: APP_SHELL_VIEWS,
          rule: 'nav-render-parity',
          message: `source-ref REGISTRY routes a provenance token to view '${view}', but AppShellViews.tsx has no \`view === '${view}'\` render branch — a task's chip would land on a blank screen. Add the render branch (or retarget the REGISTRY entry to an existing stage view).`,
        });
      }
    }
    return violations;
  },
};
