/**
 * In-memory fake {@link IMetaCtx} for isolated unit tests of the ported engine —
 * a portable clone of `tools/lint-meta/tests/test-utils/createFakeCtx.ts` (the
 * proof that rules are ctx-injectable), with the Bun `/// <reference>` dropped so
 * it compiles under plain Node types. Test-only: no `src` entrypoint imports it,
 * so it never ships in the built `dist`.
 */
import type { IMetaCtx } from './types.js';

export interface FakeFiles {
  [rel: string]: string | null;
}

export interface CreateFakeCtxOptions {
  files?: FakeFiles;
  root?: string;
  /** Optional `exec` stub; defaults to a benign `{ code: 0 }`. */
  exec?: IMetaCtx['exec'];
}

/** Minimal glob for the fake: `*` matches within a segment, `**` matches anything. */
function matchesGlob(candidate: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const re = '^' + escaped.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*') + '$';
  return new RegExp(re).test(candidate);
}

/** Build an in-memory {@link IMetaCtx} over a synthetic `rel → content` map. */
export function createFakeCtx(opts: CreateFakeCtxOptions = {}): IMetaCtx {
  const fileMap: FakeFiles = opts.files ?? {};
  const root = opts.root ?? '/fake-repo';

  return {
    root,
    read(rel: string): string | null {
      const v = fileMap[rel];
      return v === undefined || v === null ? null : v;
    },
    exists(rel: string): boolean {
      return rel in fileMap && fileMap[rel] !== null;
    },
    glob(pattern: string): string[] {
      return Object.keys(fileMap).filter((p) => matchesGlob(p, pattern));
    },
    exec: opts.exec ?? (() => ({ code: 0, stdout: '', stderr: '' })),
  };
}
