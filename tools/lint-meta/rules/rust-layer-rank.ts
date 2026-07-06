// @ts-check
import {
  rustSourceFiles,
  stripCfgTestModBlocks,
  stripLineComments,
  topLevelModule,
} from '../rust-source';
import type { IMetaRule, IViolation } from '../types';

/**
 * `rust-layer-rank` — the desktop Rust crate's fixed dependency direction (issue
 * #17). A module may `use crate::<X>` only when X is STRICTLY lower-ranked;
 * equal-rank (sideways) or higher-rank (upward) imports are forbidden. PURE text —
 * NEVER invokes cargo (the Bun lint job has no Rust toolchain).
 *
 * RANK MODEL — grounded in the REAL facade-resolved import graph (verified against
 * every non-test `crate::` edge in the crate), not a nominal guess:
 *
 *   1  contracts, infra, sync, engine_api   (pure leaves — import nothing internal)
 *   2  git                                  (→ infra only)
 *   3  store, worktree, provider            (co-tier; no sideways edges between them)
 *   4  analysis                             (→ git, store)
 *   5  orchestration, sidecar, workflow     (the ENGINE SCC — see below)
 *   6  commands, bindings                   (surfaces)
 *
 * ENGINE SCC — `orchestration`/`sidecar`/`workflow` genuinely import each other
 * (orch→sidecar/workflow, sidecar→workflow, workflow→orch/sidecar): a real cycle
 * the `Arc<dyn EngineApi>` seam only HALF-breaks. So equal-rank imports AMONG the
 * three are TOLERATED — EXCEPT `sidecar → orchestration`, which must go through the
 * `engine_api` trait (phase A.1 removed the last such edge; this keeps it gone, and
 * `rust-engine-seam` guards it independently). NOTE: this rank model follows the
 * issue #17 table + the recorded SCC decision, NOT the phase-B.2 spec's tentative
 * `sidecar/orch=4, workflow=5` split — that split would false-positive on the
 * legitimate `orch→workflow` / `sidecar→workflow` SCC edges (workflow ranks equal,
 * not above). After a future change breaks the workflow⇄sidecar half (audit #33),
 * tighten this by splitting the SCC.
 *
 * FACADE RESOLUTION — `lib.rs` (33-35) re-exports crate-root aliases; they are
 * mapped to their real modules before ranking, or upward edges would hide behind
 * `crate::task` / `crate::merge` / `crate::platform`.
 *
 * EXEMPTIONS — `lib.rs` (the composition root wires every tier) and `bindings/**`
 * (the ts-rs aggregator references all tiers by design — phase A.4). `#[cfg(test)]`
 * blocks are stripped first, so test-only helpers never trip the rule.
 */

const RANK: Record<string, number> = {
  contracts: 1,
  infra: 1,
  sync: 1,
  engine_api: 1,
  git: 2,
  store: 3,
  worktree: 3,
  provider: 3,
  analysis: 4,
  orchestration: 5,
  sidecar: 5,
  workflow: 5,
  commands: 6,
  bindings: 6,
};

/** Crate-root facade aliases → their real modules (mirror of `lib.rs` 33-35). */
const FACADE: Record<string, string> = {
  logging: 'infra',
  platform: 'infra',
  proc: 'infra',
  project: 'store',
  settings: 'store',
  task: 'store',
  transcript: 'store',
  gauntlet: 'workflow',
  gauntlet_project: 'workflow',
  kind: 'workflow',
  merge: 'workflow',
  plan_approval: 'workflow',
};

const ENGINE_SCC = new Set(['orchestration', 'sidecar', 'workflow']);

export const rustLayerRankRule: IMetaRule = {
  id: 'rust-layer-rank',
  category: 'source-text',
  ciCritical: true,
  description:
    'Desktop Rust: a module may import (crate::X) only strictly-lower-ranked modules — facades resolved, #[cfg(test)] stripped. Engine SCC (orchestration/sidecar/workflow) is co-tier except the banned sidecar→orchestration edge.',
  run(ctx) {
    const violations: IViolation[] = [];
    for (const file of rustSourceFiles(ctx)) {
      if (file.endsWith('/tests.rs')) continue;
      const fromMod = topLevelModule(file);
      if (fromMod === null || fromMod === 'bindings') continue; // exempt aggregator
      if (file.endsWith('/lib.rs')) continue; // composition root
      const fromRank = RANK[fromMod];
      if (fromRank === undefined) continue; // unranked module (none today)

      const text = stripLineComments(stripCfgTestModBlocks(ctx.read(file) ?? ''));
      const reported = new Set<string>(); // one finding per (target) per file
      for (const m of text.matchAll(/crate::([a-z_][a-z0-9_]*)/g)) {
        const target = FACADE[m[1]] ?? m[1];
        const toRank = RANK[target];
        if (toRank === undefined) continue; // not a top-level module reference
        if (target === fromMod) continue; // intra-module (post-facade)

        // Engine SCC: sideways among the three is tolerated, except sidecar→orch.
        if (ENGINE_SCC.has(fromMod) && ENGINE_SCC.has(target)) {
          if (fromMod === 'sidecar' && target === 'orchestration') {
            if (!reported.has('__seam__')) {
              reported.add('__seam__');
              violations.push({
                file,
                rule: 'rust-layer-rank',
                message:
                  'sidecar must reach the engine only through `Arc<dyn EngineApi>` — a direct `crate::orchestration::` import re-closes the cycle the engine_api seam breaks. Route it through the trait.',
              });
            }
          }
          continue;
        }

        if (toRank >= fromRank && !reported.has(target)) {
          reported.add(target);
          const kind = toRank === fromRank ? 'sideways' : 'upward';
          violations.push({
            file,
            rule: 'rust-layer-rank',
            message: `Forbidden ${kind} import: crate::${target} (rank ${toRank}) from ${fromMod} (rank ${fromRank}). Allowed direction: contracts/infra/sync/engine_api(1) → git(2) → store/worktree/provider(3) → analysis(4) → engine SCC(5) → commands(6). Add a façade/bridge seam, don't add an edge.`,
          });
        }
      }
    }
    return violations;
  },
};
