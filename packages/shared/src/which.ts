import { execFileSync } from 'node:child_process';

/**
 * Cross-platform `which`: resolve the absolute path of an executable on PATH.
 *
 * Windows has no `which` command — the equivalent is `where`. A bare
 * `execFileSync('which', …)` therefore always throws on Windows (the program
 * itself isn't found), making any caller silently report "not on PATH" even when
 * the tool is installed. This picks `where` on Windows and `which` elsewhere.
 *
 * Both `where` and `which` can print multiple matches (one per line); we return
 * the first. Returns `null` on any failure (tool not found, non-zero exit, or the
 * resolver command itself missing) so callers can degrade rather than throw.
 */
export function whichSync(bin: string): string | null {
  const resolver = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(resolver, [bin], { encoding: 'utf8' });
    const first = out.split(/\r?\n/)[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}
