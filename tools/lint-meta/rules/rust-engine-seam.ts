// @ts-check
import { SRC, stripCfgTestModBlocks, stripLineComments } from '../rust-source';
import type { IMetaRule, IViolation } from '../types';

/**
 * `rust-engine-seam` — nothing under `sidecar/**` may reference
 * `crate::orchestration::` (issue #17). PURE text — never invokes cargo.
 *
 * The 2026-06-28 backend decomposition broke the orchestration↔sidecar cycle by
 * having the sidecar reach the engine ONLY through `Arc<dyn EngineApi>`
 * (`engine_api`). A direct `crate::orchestration::` import from the sidecar
 * re-closes that cycle — exactly the regression phase A.1 fixed (it moved
 * `trips_breaker_immediately` out of `orchestration::breaker` into `contracts` so
 * `sidecar/reader.rs` stopped importing `crate::orchestration::*`). This guard
 * keeps it gone. `rust-layer-rank` also flags the edge; this dedicated rule makes
 * the specific seam explicit and independently enforced.
 *
 * Comments + `#[cfg(test)]` blocks are stripped first (the fixed violation was in
 * PRODUCTION code; a test-only helper reaching the coordinator is out of scope, and
 * the seam is documented in prose that would otherwise false-positive).
 *
 * Ships ciCritical — the clean tree has zero such references after A.1.
 */
export const rustEngineSeamRule: IMetaRule = {
  id: 'rust-engine-seam',
  category: 'source-text',
  ciCritical: true,
  description:
    'Desktop Rust: sidecar/** must not reference crate::orchestration:: — it reaches the engine only through Arc<dyn EngineApi> (the engine_api seam).',
  run(ctx) {
    const violations: IViolation[] = [];
    for (const file of ctx.glob(`${SRC}/sidecar/**/*.rs`)) {
      if (file.endsWith('/tests.rs')) continue;
      const text = stripLineComments(stripCfgTestModBlocks(ctx.read(file) ?? ''));
      if (text.includes('crate::orchestration')) {
        violations.push({
          file,
          rule: 'rust-engine-seam',
          message:
            'sidecar must reach the engine only through Arc<dyn EngineApi> — no direct crate::orchestration:: import (route it through the engine_api trait).',
        });
      }
    }
    return violations;
  },
};
