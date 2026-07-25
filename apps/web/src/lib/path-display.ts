/** Shared, presentation-only path helpers.
 *
 *  Lives in `@/lib` (not a feature) so BOTH the terminal feature and the shared
 *  `components/ui` folder browser can display canonical paths cleanly without a
 *  cross-feature import. The terminal feature re-exports {@link displayPath} from
 *  `terminal-shared` for its existing call sites. */

/** Strip a Windows extended-length "verbatim" prefix from a path, for DISPLAY only.
 *  `std::fs::canonicalize` emits `\\?\C:\…` on Windows, and Nightcore canonicalizes
 *  paths server-side (project store, terminal cwds, directory listings), so those
 *  paths reach the UI. Maps `\\?\C:\x` → `C:\x` and `\\?\UNC\server\share` →
 *  `\\server\share`; every non-verbatim string (all POSIX paths, and already-clean
 *  Windows paths) passes through untouched.
 *
 *  DISPLAY ONLY: callers keep the canonical string for spawn cwds and membership /
 *  restore checks (the server re-canonicalizes any cwd/dir path it receives), so
 *  this never weakens a confinement or existence comparison. */
export function displayPath(path: string): string {
  const VERBATIM_UNC = '\\\\?\\UNC\\';
  const VERBATIM = '\\\\?\\';
  if (path.startsWith(VERBATIM_UNC)) return `\\\\${path.slice(VERBATIM_UNC.length)}`;
  if (path.startsWith(VERBATIM)) return path.slice(VERBATIM.length);
  return path;
}

/** The last non-empty segment of a path (its "leaf" folder/file name). Strips the
 *  Windows verbatim prefix and splits on BOTH separators, so `\\?\X:\dev\nightcore`
 *  and `/home/x/nightcore` both yield `nightcore`. Returns the (display) path itself
 *  when it has no separators. */
export function pathLeaf(path: string): string {
  const pretty = displayPath(path);
  const parts = pretty.split(/[/\\]+/).filter((seg) => seg.length > 0);
  return parts[parts.length - 1] ?? pretty;
}

/** Split a (display) path into a truncatable directory prefix and its
 *  always-visible leaf (filename). For leaf-preserving display: render `dir` in a
 *  `truncate` span and `leaf` in a `shrink-0` span, so a long path clips its middle
 *  directories instead of the filename. Windows verbatim prefixes are stripped
 *  first (via {@link displayPath}). `dir` includes the trailing separator; it is
 *  empty when the path has no separators. */
export function splitPathLeaf(path: string): { dir: string; leaf: string } {
  const pretty = displayPath(path);
  const leaf = pathLeaf(path);
  return { dir: pretty.slice(0, pretty.length - leaf.length), leaf };
}
