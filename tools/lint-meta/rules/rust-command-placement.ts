// @ts-check
import {
  rustSourceFiles,
  stripCfgTestModBlocks,
  stripLineComments,
  topLevelModule,
} from '../rust-source';
import type { IMetaRule, IViolation } from '../types';

/**
 * `rust-command-placement` — no `#[tauri::command]` in the desktop crate's LEAF
 * tier (issue #17). PURE text — never invokes cargo.
 *
 * A `#[tauri::command]` handler is a SURFACE concern: it belongs in `commands/` or,
 * for a feature, co-located in its engine/feature module (`sidecar`, `workflow`).
 * It must never live in the leaf tier — `contracts`, `infra`, `sync`, `git`,
 * `engine_api`, `store`, `worktree`, `provider` — which are pure
 * persistence/primitive/type modules with no IPC surface. This is deliberately a
 * LEAF-TIER ban, NOT a "commands/-only" rule: 119/120 handlers already comply, and
 * feature handlers stay co-located by design (a commands/-only rule would produce
 * ~88 false positives).
 *
 * Ships ciCritical — phase A.2 moved the lone leaf-tier handler
 * (`read_transcript`, formerly in `store/transcript.rs`) up to `commands/`, so the
 * clean tree has zero violations.
 *
 * Comments + `#[cfg(test)]` blocks are stripped first: several leaf `mod.rs` docs
 * MENTION `#[tauri::command]` in prose (e.g. `store/task/mod.rs`: "the
 * `#[tauri::command]` handlers … moved up to the command layer"), which a raw
 * substring check would false-positive on.
 */

const LEAF_TIER = new Set([
  'contracts',
  'infra',
  'sync',
  'git',
  'engine_api',
  'store',
  'worktree',
  'provider',
]);

export const rustCommandPlacementRule: IMetaRule = {
  id: 'rust-command-placement',
  category: 'source-text',
  ciCritical: true,
  description:
    'Desktop Rust: no #[tauri::command] in the leaf tier (contracts/infra/sync/git/engine_api/store/worktree/provider) — handlers belong in commands/ or a feature module.',
  run(ctx) {
    const violations: IViolation[] = [];
    for (const file of rustSourceFiles(ctx)) {
      if (file.endsWith('/tests.rs')) continue;
      const mod = topLevelModule(file);
      if (mod === null || !LEAF_TIER.has(mod)) continue;
      const text = stripLineComments(stripCfgTestModBlocks(ctx.read(file) ?? ''));
      if (text.includes('#[tauri::command')) {
        violations.push({
          file,
          rule: 'rust-command-placement',
          message: `Tauri commands belong in commands/ (or a feature/engine module), not the leaf tier — move this #[tauri::command] handler out of ${mod}/ and leave a thin wrapper in commands/.`,
        });
      }
    }
    return violations;
  },
};
