import type { IMetaCtx } from '../lint-meta/types.js';

/** The repo's GitHub Actions workflows (`.github/workflows/*.yml` and `*.yaml`), sorted. */
export function workflowFiles(ctx: IMetaCtx): string[] {
  const found = new Set([
    ...ctx.glob('.github/workflows/*.yml'),
    ...ctx.glob('.github/workflows/*.yaml'),
  ]);
  return [...found].sort();
}
