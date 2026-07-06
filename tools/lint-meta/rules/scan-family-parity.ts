// @ts-check
import type { IMetaRule, IViolation } from '../types';

/**
 * Scan-family parity: the scan-view siblings (insight / harness / scorecard /
 * issues, plus the concurrent prreview) converged on shared run primitives —
 * `lib/useScanRun` for the single-run lifecycle and `lib/scan-run` for the
 * fold/phase helpers. Nothing in ESLint enforces that convergence: a 6th scan
 * family could be built as a fresh clone and lint would stay green. This rule
 * makes divergence a CI failure:
 *
 *   (a) every enrolled single-run family's `<View>.hooks.ts` must build on
 *       `@/lib/useScanRun`;
 *   (b) every enrolled family's `components/<family>/*-stream.ts` must import
 *       from `@/lib/scan-run` (board/session-stream.ts is the task-session
 *       activity fold, NOT a scan family, so it is exempt by not being
 *       enrolled);
 *   (c) no file under `components/**` may re-declare the shared primitives
 *       (`deriveRunPhase` / `useScanRun` / `seedStepState`) — the
 *       local-reimplementation tripwire;
 *   (d) a `components/<new>/<new>-stream.ts` whose `<new>` is not enrolled is
 *       a new scan family — enrolling it here is a conscious act.
 */

const WEB_COMPONENTS = 'apps/web/src/components';

/** family folder → its scan view component (owner of the `.hooks.ts` file). */
const SINGLE_RUN_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ['insight', 'InsightView'],
  ['harness', 'HarnessView'],
  ['scorecard', 'ScorecardView'],
  ['issues', 'IssueTriageView'],
];

/** Families with concurrent per-item runs — no single `useScanRun` lifecycle. */
const CONCURRENT_FAMILIES: readonly string[] = ['prreview'];

const ENROLLED = new Set<string>([
  ...SINGLE_RUN_FAMILIES.map(([family]) => family),
  ...CONCURRENT_FAMILIES,
]);

/** Local re-declarations of the shared scan-run primitives. */
const SHADOW_PATTERN =
  /\b(?:function|const)\s+(deriveRunPhase|useScanRun|seedStepState)\b/;

export const scanFamilyParityRule: IMetaRule = {
  id: 'scan-family-parity',
  category: 'source-text',
  ciCritical: true,
  description:
    'Scan-view families must build on the shared lib/useScanRun + lib/scan-run primitives; a new scan family must be consciously enrolled.',
  run(ctx) {
    const violations: IViolation[] = [];

    // (a) each single-run family's view hooks must use the shared lifecycle.
    for (const [family, view] of SINGLE_RUN_FAMILIES) {
      const hooks = `${WEB_COMPONENTS}/${family}/${view}/${view}.hooks.ts`;
      const content = ctx.read(hooks);
      if (content === null) {
        violations.push({
          file: hooks,
          rule: 'scan-family-parity',
          message: `Enrolled scan family '${family}' has no ${view}.hooks.ts — if the view was renamed/moved, update SINGLE_RUN_FAMILIES in tools/lint-meta/rules/scan-family-parity.ts.`,
        });
        continue;
      }
      if (!content.includes("from '@/lib/useScanRun'")) {
        violations.push({
          file: hooks,
          rule: 'scan-family-parity',
          message: `Scan family '${family}' must drive its run lifecycle through the shared '@/lib/useScanRun' hook — do not re-clone the run state machine.`,
        });
      }
    }

    // Stream files: `components/<dir>/<base>-stream.ts`.
    const streams = ctx.glob(`${WEB_COMPONENTS}/*/*-stream.ts`);
    for (const rel of streams) {
      const segments = rel.split('/');
      const dir = segments[segments.length - 2] ?? '';
      const base = (segments[segments.length - 1] ?? '').replace(
        /-stream\.ts$/,
        '',
      );

      // (b) an enrolled family's stream fold must build on lib/scan-run.
      if (ENROLLED.has(dir)) {
        const content = ctx.read(rel) ?? '';
        if (!content.includes("from '@/lib/scan-run'")) {
          violations.push({
            file: rel,
            rule: 'scan-family-parity',
            message: `Scan family '${dir}' stream fold must import from '@/lib/scan-run' (deriveRunPhase/seedStepState/usage helpers) — do not re-implement the shared fold primitives.`,
          });
        }
        continue;
      }

      // (d) `<new>/<new>-stream.ts` outside the enrolled set = an unenrolled
      // scan family. Enroll it (SINGLE_RUN_FAMILIES or CONCURRENT_FAMILIES).
      if (base === dir) {
        violations.push({
          file: rel,
          rule: 'scan-family-parity',
          message: `'components/${dir}/${dir}-stream.ts' looks like a new scan family — enroll '${dir}' in SINGLE_RUN_FAMILIES or CONCURRENT_FAMILIES (tools/lint-meta/rules/scan-family-parity.ts) and build it on '@/lib/useScanRun' + '@/lib/scan-run'.`,
        });
      }
    }

    // (c) shadow guard — no local re-declaration of the shared primitives
    // anywhere under components/. Bun's Glob has no `{ts,tsx}` brace
    // alternation, so glob each extension separately and merge.
    const componentFiles = [
      `${WEB_COMPONENTS}/**/*.ts`,
      `${WEB_COMPONENTS}/**/*.tsx`,
    ].flatMap((pattern) => ctx.glob(pattern));
    for (const rel of componentFiles) {
      const content = ctx.read(rel) ?? '';
      const match = SHADOW_PATTERN.exec(content);
      if (match) {
        violations.push({
          file: rel,
          rule: 'scan-family-parity',
          message: `Local declaration of '${match[1]}' shadows the shared scan-run primitive — import it from '@/lib/scan-run' / '@/lib/useScanRun' instead.`,
        });
      }
    }

    return violations;
  },
};
