/**
 * The glob behind `ctx.glob`, identical under Node and Bun.
 *
 * Node's `fs.globSync` is the reference and is used as-is under Node. Bun ships
 * its own `node:fs` `globSync`, and it cannot see a dot-directory at all: under
 * Bun 1.3.14 `.github/workflows/*.yml` returns `[]` even though the path is
 * spelled out literally, and neither a `dot` option nor Bun's `path.matchesGlob`
 * (which lets `**` cross dot-directories, unlike Node) can repair it. A rule that
 * globs workflows would then report nothing, forever, while looking green.
 *
 * So under Bun this module walks the tree itself with Node's rules:
 *  - a pattern segment is a literal, `**`, or a wildcard segment (`*`, `?`,
 *    `[...]`, `\` escapes), after `{a,b}` brace expansion. Literals before the
 *    first wildcard resolve through the filesystem (so they follow the disk's
 *    case rules, as in Node); a literal after a wildcard must match a directory
 *    entry exactly;
 *  - a wildcard never matches a leading `.` unless the segment itself starts with
 *    a literal `.`, and `**` never enters a dot-directory or a symlinked one;
 *  - wildcard segments are case-insensitive on macOS and Windows, as in Node;
 *  - a trailing `/` matches real directories only (not symlinks to one), `.`
 *    segments are dropped, and `..`
 *    walks up, with the result normalized.
 * Syntax Node supports but this walker does not (extglobs such as `+(a|b)`,
 * POSIX classes, brace ranges) THROWS instead of matching nothing, so a rule that
 * uses it fails loudly rather than silently passing.
 *
 * One known difference: Node's `**` is inconsistent about symlinked directories
 * (`**` + `/*` lists one level inside one, `**` + `/*.ts` does not); this walker
 * never enters one through `**`. Results are sorted on both runtimes.
 */
import { globSync, lstatSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** Whether this process is Bun, whose `node:fs` `globSync` is not Node's. */
export function isBunRuntime(): boolean {
  return typeof process.versions.bun === 'string';
}

/** Node's `fs.glob` matches wildcard parts case-insensitively on these platforms. */
const NOCASE = process.platform === 'darwin' || process.platform === 'win32';

/**
 * Glob `pattern` relative to `cwd`, returning forward-slashed relative paths,
 * sorted. Uses Node's `fs.globSync` under Node and {@link walkGlob} under Bun.
 */
export function portableGlob(pattern: string, cwd: string): string[] {
  const matches = isBunRuntime()
    ? walkGlob(pattern, cwd)
    : Array.from(globSync(pattern, { cwd }), (rel) => rel.replace(/\\/g, '/'));
  return [...new Set(matches)].sort();
}

/** A compiled pattern segment. */
type Segment =
  | { kind: 'globstar' }
  | { kind: 'literal'; text: string }
  | { kind: 'wild'; re: RegExp; allowDot: boolean };

class UnsupportedGlobError extends Error {
  constructor(pattern: string, what: string) {
    super(
      `ctx.glob("${pattern}"): ${what} is not supported under Bun. ` +
        'Rewrite the pattern without it, or run the harness under Node.',
    );
  }
}

/** Expand `{a,b}` groups (nested allowed) into plain patterns. */
function expandBraces(pattern: string, original: string): string[] {
  let depth = 0;
  let open = -1;
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '\\') {
      i += 1;
    } else if (ch === '{') {
      if (depth === 0) open = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) {
        const body = pattern.slice(open + 1, i);
        const alternatives = splitTopLevelCommas(body);
        if (alternatives.length < 2) {
          if (/^-?\d+\.\.-?\d+$|^[a-zA-Z]\.\.[a-zA-Z]$/.test(body)) {
            throw new UnsupportedGlobError(original, `the brace range "{${body}}"`);
          }
          continue; // `{x}` with no comma is a literal, as in Node
        }
        const head = pattern.slice(0, open);
        const tail = pattern.slice(i + 1);
        return alternatives.flatMap((alt) => expandBraces(head + alt + tail, original));
      }
    }
  }
  return [pattern];
}

function splitTopLevelCommas(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\') i += 1;
    else if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

const REGEX_SPECIAL = /[.+^${}()|[\]\\/*?]/;

/** Compile one path segment (no `/`) into a {@link Segment}. */
function compileSegment(segment: string, original: string): Segment {
  if (segment === '**') return { kind: 'globstar' };
  if (/[?*+@!]\(/.test(segment)) throw new UnsupportedGlobError(original, 'an extglob');

  let source = '';
  let literal = '';
  let magic = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i] ?? '';
    if (ch === '\\' && i + 1 < segment.length) {
      const next = segment[i + 1] ?? '';
      i += 1;
      source += REGEX_SPECIAL.test(next) ? `\\${next}` : next;
      literal += next;
    } else if (ch === '*') {
      magic = true;
      source += '[^/]*';
    } else if (ch === '?') {
      magic = true;
      source += '[^/]';
    } else if (ch === '[') {
      const close = segment.indexOf(']', i + 2);
      if (close === -1) {
        source += '\\[';
        literal += ch;
        continue;
      }
      let body = segment.slice(i + 1, close);
      if (body.includes('[:')) throw new UnsupportedGlobError(original, 'a POSIX character class');
      const negate = body.startsWith('!') || body.startsWith('^');
      if (negate) body = body.slice(1);
      magic = true;
      source += `[${negate ? '^' : ''}${body.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`;
      i = close;
    } else {
      source += REGEX_SPECIAL.test(ch) ? `\\${ch}` : ch;
      literal += ch;
    }
  }

  if (!magic) return { kind: 'literal', text: literal };
  return {
    kind: 'wild',
    re: new RegExp(`^${source}$`, NOCASE ? 'i' : ''),
    allowDot: segment.startsWith('.'),
  };
}

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function listDir(abs: string): { name: string; isDir: boolean; isRealDir: boolean }[] {
  try {
    return readdirSync(abs, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isRealDir: entry.isDirectory(),
      isDir: entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(abs, entry.name))),
    }));
  } catch {
    return [];
  }
}

function exists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

function isRealDirectory(abs: string): boolean {
  try {
    return lstatSync(abs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Walk `cwd` for `pattern` with Node's glob semantics (see the module doc). Pure
 * over the real filesystem; exported so it can be tested under any runtime.
 */
export function walkGlob(pattern: string, cwd: string): string[] {
  const normalized = process.platform === 'win32' ? pattern.replace(/\\/g, '/') : pattern;
  const out = new Set<string>();

  for (const expanded of expandBraces(normalized, pattern)) {
    const dirOnly = expanded.endsWith('/');
    const segments = expanded
      .split('/')
      .filter((part) => part !== '' && part !== '.')
      .map((part) => compileSegment(part, pattern));
    if (segments.length === 0) continue;
    const firstMagic = segments.findIndex((segment) => segment.kind !== 'literal');

    const record = (rel: string): void => {
      if (dirOnly && !isRealDirectory(path.join(cwd, rel))) return;
      out.add(rel === '' ? '.' : path.posix.normalize(rel));
    };

    // `rel` is the forward-slashed path walked so far ('' = cwd).
    const visit = (rel: string, index: number): void => {
      if (index === segments.length) {
        record(rel);
        return;
      }
      const segment = segments[index];
      if (segment === undefined) return;
      const abs = path.join(cwd, rel);
      const join = (name: string): string => (rel === '' ? name : `${rel}/${name}`);
      const last = index === segments.length - 1;

      if (segment.kind === 'literal') {
        const next = join(segment.text);
        const afterMagic = firstMagic !== -1 && index > firstMagic;
        if (afterMagic) {
          const entry = listDir(abs).find((candidate) => candidate.name === segment.text);
          if (entry !== undefined && (last || entry.isDir)) visit(next, index + 1);
        } else if (last ? exists(path.join(cwd, next)) : isDirectory(path.join(cwd, next))) {
          visit(next, index + 1);
        }
        return;
      }

      if (segment.kind === 'globstar') {
        // Zero segments here, then one more real (non-dot, non-symlink) directory.
        // A trailing `**` also matches every non-dot entry below it.
        visit(rel, index + 1);
        for (const entry of listDir(abs)) {
          if (entry.name.startsWith('.')) continue;
          if (entry.isRealDir) visit(join(entry.name), index);
          else if (last) record(join(entry.name));
        }
        return;
      }

      for (const entry of listDir(abs)) {
        if (entry.name.startsWith('.') && !segment.allowDot) continue;
        if (!segment.re.test(entry.name)) continue;
        if (last || entry.isDir) visit(join(entry.name), index + 1);
      }
    };

    visit('', 0);
  }

  return [...out];
}
