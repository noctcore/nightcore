// @ts-check
import { rustSourceFiles, stripCfgTestModBlocks } from '../rust-source';
import type { IMetaRule, IViolation } from '../types';

/**
 * `rust-module-shape` — the desktop Rust crate's module hygiene (issue #17).
 *
 * PURE filesystem/text analysis — NEVER invokes cargo. The Bun `lint`/`lint:meta`
 * CI job has no Rust toolchain or Tauri system deps, so shelling to `cargo` would
 * red that job (a repo-documented trap). Everything here is `ctx.read`/`ctx.glob`.
 *
 * Two checks over `apps/desktop/src-tauri/src/**`:
 *
 *  1. MANIFEST — every `mod.rs` must be a manifest: only `mod`/`pub mod`/
 *     `pub(crate) mod` declarations, `use`/`pub use` re-exports, docs, and
 *     attributes. A top-level `fn`/`impl`/`struct`/`enum`/`trait`/`macro_rules!`/
 *     `const` with a body belongs in a sibling file, re-exported from the mod.rs
 *     (the house pattern — see `worktree/mod.rs`). `lib.rs` is NOT a `mod.rs` (so
 *     it is never matched) and legitimately holds `run()` + `generate_handler!`.
 *
 *  2. SIZE CAP — every `.rs` file (except sibling `tests.rs`, which are skipped
 *     entirely) is measured in CODE LINES: physical lines EXCLUDING blank lines,
 *     `//`/`///`/`//!` comment-only lines, and everything inside a
 *     `#[cfg(test)] mod … { … }` block. Inline `#[cfg(test)]` tests are ~37% of
 *     the crate, so a raw line cap would be gamed by shuffling them; the code-line
 *     measure is the honest one. Over 400 = HARD violation (the ciCritical
 *     signal); 350..=400 = a non-blocking advisory emitted as a LOG line (never a
 *     returned violation, so it can never fail the gate).
 *
 * PHASED GATING — this rule ships `ciCritical: false` (advisory) in phase B.1:
 * the crate still has real god-files over 400 (`analysis/repo_map.rs` ~805,
 * `sidecar/mod.rs`, `workflow/pr_fix/command.rs` ~682, …) and `mod.rs` files still
 * holding logic (`store/mod.rs`'s `TaskStore` impl, `sidecar/mod.rs`), so every
 * finding here is informational for now. Phase C adds the `baselines/` ratchet that
 * grandfathers today's offenders + the permanent exemptions, then flips this rule
 * to `ciCritical: true` so a NEW over-cap file or a NEW mod.rs-with-logic fails CI
 * while the frozen offenders pass until their split lands (phase D).
 */

const HARD_CAP = 400;
const ADVISORY_CAP = 350;

/**
 * CODE LINES of a Rust source: physical lines minus blank lines, `//`-style
 * comment-only lines, and every line inside a `#[cfg(test)] mod … { … }` block.
 * A `#[cfg(test)]` on a non-mod item (a `use`/`fn`) is NOT excluded — only whole
 * test MODULES are (via the shared [`stripCfgTestModBlocks`]).
 */
export function countCodeLines(text: string): number {
  return stripCfgTestModBlocks(text)
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t !== '' && !t.startsWith('//');
    }).length;
}

/** A disallowed top-level item found in a `mod.rs`: its 1-indexed line + keyword. */
export interface ManifestOffense {
  line: number;
  keyword: string;
}

/**
 * Top-level items in a `mod.rs` that break the manifest rule: a `fn`/`impl`/
 * `struct`/`enum`/`trait`/`macro_rules!`/`const` body at brace-depth 0. `mod`/`use`
 * declarations, docs, and attributes are allowed. `#[cfg(test)] mod … { … }` blocks
 * are stripped first (an inline test module is a `mod` decl, not logic).
 */
export function manifestOffenses(text: string): ManifestOffense[] {
  const lines = text.split('\n');
  const offenses: ManifestOffense[] = [];
  let depth = 0;
  let i = 0;
  const ITEM =
    /^(pub(\([^)]*\))?\s+)?(async\s+)?(unsafe\s+)?((fn|impl|struct|enum|trait|const)\b|macro_rules!)/;
  while (i < lines.length) {
    const raw = lines[i];
    const trimmed = raw.trim();
    // Strip whole `#[cfg(test)] mod … { … }` blocks (same detection as the counter).
    if (trimmed === '#[cfg(test)]' || trimmed.startsWith('#[cfg(test)]')) {
      let j = i + 1;
      while (
        j < lines.length &&
        (lines[j].trim() === '' ||
          lines[j].trim().startsWith('//') ||
          lines[j].trim().startsWith('#['))
      ) {
        j++;
      }
      if (j < lines.length && /^\s*(pub(\([^)]*\))?\s+)?mod\s+\w+/.test(lines[j]) && lines[j].includes('{')) {
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
    // Remove a trailing line comment before keyword/brace analysis.
    const codePart = stripLineComment(raw);
    const codeTrim = codePart.trim();
    if (depth === 0 && codeTrim !== '') {
      const m = codeTrim.match(ITEM);
      if (m) {
        offenses.push({ line: i + 1, keyword: m[5] ? m[5] : 'macro_rules!' });
      }
    }
    for (const ch of codePart) {
      if (ch === '{') depth++;
      else if (ch === '}') depth = Math.max(0, depth - 1);
    }
    i++;
  }
  return offenses;
}

/** Drop a `// …` line comment (naive — good enough for the simple mod.rs surface). */
function stripLineComment(line: string): string {
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

export const rustModuleShapeRule: IMetaRule = {
  id: 'rust-module-shape',
  category: 'source-text',
  // Advisory in phase B.1 (god-files + logic-bearing mod.rs still exist). Phase C
  // adds the ratchet baseline + permanent exemptions and flips this to `true`.
  ciCritical: false,
  description:
    "Desktop Rust: mod.rs is a manifest (declarations + re-exports only) and no code file exceeds 400 code lines (excluding #[cfg(test)] blocks). Advisory until the phase-C ratchet grandfathers today's offenders.",
  run(ctx) {
    const violations: IViolation[] = [];
    for (const file of rustSourceFiles(ctx)) {
      const text = ctx.read(file);
      if (text === null) continue;

      // MANIFEST — mod.rs files only. One summary violation per file (the phase-C
      // ratchet baselines the offense COUNT, so a file may shed items but never
      // gain them).
      if (file.endsWith('/mod.rs')) {
        const offenses = manifestOffenses(text);
        if (offenses.length > 0) {
          const where = offenses
            .map((o) => `${o.keyword}@${o.line}`)
            .join(', ');
          violations.push({
            file,
            rule: 'rust-module-shape',
            message: `mod.rs is a manifest but holds ${offenses.length} top-level item(s) that belong in sibling files, re-exported (house pattern: worktree/mod.rs): ${where}. Only mod/use declarations, docs, and attributes belong in a mod.rs.`,
          });
        }
      }

      // SIZE CAP — every .rs except sibling tests.rs files.
      if (file.endsWith('/tests.rs')) continue;
      const code = countCodeLines(text);
      if (code > HARD_CAP) {
        violations.push({
          file,
          rule: 'rust-module-shape',
          message: `code file exceeds the ${HARD_CAP}-line hard cap: ${code} code lines (excluding #[cfg(test)] blocks + blank/comment lines). Split into flat siblings under a thin mod.rs (house pattern: worktree/).`,
        });
      } else if (code > ADVISORY_CAP) {
        // Non-blocking advisory: a LOG line, never a returned violation, so it can
        // never fail the gate even after this rule flips to ciCritical in phase C.
        console.error(
          `[advisory] rust-module-shape (${file}): ${code} code lines — approaching the ${HARD_CAP}-line hard cap.`,
        );
      }
    }
    return violations;
  },
};
