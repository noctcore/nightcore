// @ts-check
import type { IMetaRule } from '../types';

/**
 * The zod→Rust codegen output (`generated.rs`) must match the @nightcore/contracts
 * source. `gen-rust-contracts.ts --check` regenerates in-memory and exits non-zero
 * on any difference. (The ts-rs direction — Rust→web TS — is verified by
 * `cargo test`, run in `test:rust`.)
 */
export const codegenDriftRule: IMetaRule = {
  id: 'codegen-drift',
  category: 'config',
  ciCritical: true,
  description:
    'Committed Rust contract codegen must match the @nightcore/contracts zod source. Regenerate with `bun run codegen:contracts`; never hand-edit generated.rs.',
  run(ctx) {
    const res = ctx.exec('bun run tools/codegen/gen-rust-contracts.ts --check');
    if (res.code === 0) return [];
    const detail = (res.stdout || res.stderr).trim();
    return [
      {
        file: 'apps/desktop/src-tauri/src/contracts/generated.rs',
        rule: 'codegen-drift',
        message:
          'Generated Rust contracts drifted from the packages/contracts zod schemas. Run `bun run codegen:contracts` and commit the result.' +
          (detail ? `\n${detail}` : ''),
      },
    ];
  },
};
