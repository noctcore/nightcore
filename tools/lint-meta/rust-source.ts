// @ts-check
import type { IMetaCtx } from './types';

/**
 * Shared text primitives for the desktop-Rust `rust-*` lint-meta rules (issue #17).
 * Pure string analysis — these rules never invoke cargo (the Bun lint CI job has no
 * Rust toolchain or Tauri system deps).
 */

/** The desktop Tauri crate's Rust source root (repo-relative). */
export const SRC = 'apps/desktop/src-tauri/src';

/** Every `.rs` file under the desktop crate src (Bun glob — no brace-alternation). */
export function rustSourceFiles(ctx: IMetaCtx): string[] {
  return ctx.glob(`${SRC}/**/*.rs`);
}

/** The top-level crate module a repo-relative `${SRC}/…` path belongs to. */
export function topLevelModule(file: string): string | null {
  if (!file.startsWith(`${SRC}/`)) return null;
  return file.slice(SRC.length + 1).split('/')[0].replace(/\.rs$/, '');
}

/**
 * Remove every `#[cfg(test)] mod … { … }` block from `text` (the attribute line
 * through the brace-matched close, or EOF). Only whole test MODULES are stripped —
 * a `#[cfg(test)]` on a `use`/`fn` is left in place. Detection skips intervening
 * attributes/comments/blanks between the attribute and the `mod` line, and treats a
 * `mod foo;` decl (no inline `{`) as a plain declaration, not a block.
 *
 * Line-removing (the result has FEWER lines), so callers that need original line
 * numbers must not use this — it is for line-count and import-scan callers.
 */
export function stripCfgTestModBlocks(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (t === '#[cfg(test)]' || t.startsWith('#[cfg(test)]')) {
      let j = i + 1;
      while (
        j < lines.length &&
        (lines[j].trim() === '' ||
          lines[j].trim().startsWith('//') ||
          lines[j].trim().startsWith('#['))
      ) {
        j++;
      }
      if (
        j < lines.length &&
        /^\s*(pub(\([^)]*\))?\s+)?mod\s+\w+/.test(lines[j]) &&
        lines[j].includes('{')
      ) {
        let d = 0;
        let k = j;
        let opened = false;
        while (k < lines.length) {
          for (const ch of lines[k]) {
            if (ch === '{') {
              d++;
              opened = true;
            } else if (ch === '}') d--;
          }
          if (opened && d <= 0) break;
          k++;
        }
        i = k + 1;
        continue;
      }
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/** Drop `// …` line comments (naive — good enough for the simple crate surface). */
export function stripLineComments(text: string): string {
  return text
    .split('\n')
    .map((l) => {
      const idx = l.indexOf('//');
      return idx === -1 ? l : l.slice(0, idx);
    })
    .join('\n');
}
