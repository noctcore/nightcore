/**
 * `@nightcore/contracts` — EDIT-TIME diagnostics for harness policy entries
 * (issue #400, the highest-value half: "a typo'd rule silently doesn't exist").
 *
 * THE PROBLEM THIS SOLVES. Every policy tier fails OPEN on a bad entry, and for
 * good reasons: an invalid `denyBashPatterns` regex is warn-and-skipped so one
 * typo cannot brick the whole layer, and the path-glob engine supports only `*`
 * and `**` so `migrations/{a,b}` compiles to a rule that matches the literal
 * three-character directory `{a,b}` and nothing else. Both postures are correct
 * at RUNTIME and catastrophic at AUTHORING time: the author reads their own rule
 * back, believes they are protected, and is not. A silently-dead rule
 * manufactures false confidence, which is worse than no rule at all.
 *
 * So the fail-open runtime keeps its posture and this module moves the truth
 * FORWARD to the editor: given one raw entry and which tier it belongs to,
 * return the reason it can never fire (`error`) or the reason it probably does
 * not do what the author meant (`warning`). Pure, dependency-free, and shared
 * with the engine's compile wrappers so a message the editor shows is the same
 * fact the gate logs.
 *
 * SEVERITY CONTRACT — the editor blocks Save on `error`, never on `warning`:
 *   - `error`   ⇒ this entry is PROVABLY dead. It cannot match any input the
 *                 gate will ever evaluate (an uncompilable regex, a `..`
 *                 segment, permission-rule syntax in an exact-match tier).
 *   - `warning` ⇒ it compiles and can fire, but the shape is a known
 *                 foot-gun (a glob written into a regex tier, a `**` that
 *                 silently protects the entire repo, an unrecognized tool name).
 * A `warning` must never block authoring: the author may know something the
 * heuristic does not (a private MCP tool name, a literal `[id]` directory).
 */
import {
  compileBashPattern,
  isMcpGlobEntry,
  MAX_BASH_PATTERN_LENGTH,
} from './policy-patterns.js';

/** Which policy tier an entry belongs to — selects the diagnostic rules.
 *   - `path`            — `protectedPaths` / `denyReadPaths` / `allowExecSinks`
 *                         (the repo-relative glob engine).
 *   - `bash-regex`      — `denyBashPatterns` (JS regexes over the raw command).
 *   - `tool`            — `disallowedTools` / `askTools` (exact SDK tool names
 *                         plus `mcp__server__*`).
 *   - `permission-rule` — `allowTools` (VERBATIM SDK permission-rule strings).
 */
export type PolicyEntryKind = 'path' | 'bash-regex' | 'tool' | 'permission-rule';

/** How badly wrong an entry is. See the module header's severity contract. */
export type PolicyEntrySeverity = 'error' | 'warning';

/** One diagnostic about one policy entry. `message` is written to be shown
 *  verbatim next to the input — it names the consequence ("never matches"),
 *  not the internals. */
export interface PolicyEntryDiagnostic {
  severity: PolicyEntrySeverity;
  message: string;
}

/** The native SDK tool names the exact-match tiers can meaningfully name. Used
 *  ONLY for authoring hints (an unknown name is a `warning`, never an `error`) —
 *  the SDK, not this list, decides what tools exist, and a project may legitimately
 *  name a tool this list has not learned about yet. Kept in sync by hand with the
 *  toolsets the engine presets reference (`providers/claude/kind-presets.ts`,
 *  `scans/shared/presets.ts`). */
export const NATIVE_SDK_TOOLS: readonly string[] = [
  'Agent',
  'ApplyPatch',
  'Bash',
  'BashOutput',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'KillShell',
  'LS',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Read',
  'Task',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
] as const;

/** Glob metacharacters the path engine does NOT implement and therefore matches
 *  LITERALLY. `[`/`]` are deliberately absent: a literal `app/[id]/**` directory
 *  is real and common (file-router conventions), and matching it literally is
 *  exactly what its author wants. */
const UNSUPPORTED_GLOB_CHARS = ['{', '}', '?'] as const;

/** A bare path-glob shape (`.env*`, `**\/*.lock`, `src/*`): only path
 *  characters plus `*`. Used to catch a glob written into the regex tier, where
 *  `*` means "repeat the previous character" and the rule matches nonsense. */
const PATH_GLOB_SHAPE = /^[\w.\-/*]*\*[\w.\-/*]*$/;

/** Diagnostics for a repo-relative path glob (`protectedPaths`,
 *  `denyReadPaths`, `allowExecSinks`). Returns the FIRST decisive problem —
 *  one clear reason beats a pile of overlapping ones. */
function pathDiagnostic(raw: string): PolicyEntryDiagnostic | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { severity: 'error', message: 'Empty entry — the engine skips it.' };
  }
  if (trimmed.startsWith('!')) {
    return {
      severity: 'error',
      message: 'Negation (`!`) is not supported — this rule never matches. Remove the entry instead.',
    };
  }
  if (trimmed.includes('\\')) {
    return {
      severity: 'error',
      message:
        'Backslashes are not path separators here — use `/`. As written, the whole entry is one literal segment and never matches.',
    };
  }
  if (/^[A-Za-z]:/.test(trimmed)) {
    return {
      severity: 'error',
      message: 'Patterns are repo-relative — a drive-letter path never matches.',
    };
  }
  if (trimmed.startsWith('~')) {
    return {
      severity: 'error',
      message: '`~` is not expanded — this matches a literal `~` directory and never fires.',
    };
  }
  if (pathSegmentsOf(trimmed).includes('..')) {
    return {
      severity: 'error',
      message:
        '`..` never appears in a repo-relative path, so this rule can never match. Write the path from the repo root.',
    };
  }
  const unsupported = UNSUPPORTED_GLOB_CHARS.find((char) => trimmed.includes(char));
  if (unsupported !== undefined) {
    return {
      severity: 'error',
      message:
        `\`${unsupported}\` is matched literally — only \`*\` (within a segment) and \`**\` ` +
        '(across segments) are supported, so this rule is effectively dead. Split it into separate entries.',
    };
  }
  if (trimmed.includes('://')) {
    return {
      severity: 'error',
      message: 'This looks like a URL — patterns are repo-relative paths and this never matches.',
    };
  }
  if (trimmed === '*' || trimmed === '**' || trimmed === '**/*') {
    return {
      severity: 'warning',
      message: 'Matches every path in the repo — every file is covered by this one rule.',
    };
  }
  if (/^\/?(Users|home|var|tmp|opt|private|mnt|etc)\//.test(trimmed)) {
    return {
      severity: 'warning',
      message:
        'A leading `/` anchors at the REPO root, not the filesystem root — an absolute machine path never matches.',
    };
  }
  return null;
}

/** Segments of a trimmed pattern, tolerating the leading `./`/`/` and trailing
 *  `/` the compiler accepts as author sugar. Local to the diagnostics (the
 *  matcher's own splitter takes a resolved path, not a pattern). */
function pathSegmentsOf(trimmed: string): string[] {
  return trimmed
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((segment) => segment.length > 0);
}

/** Diagnostics for a `denyBashPatterns` entry — a JS regex over the raw command
 *  line. The compile failure the engine warn-and-skips becomes the author's
 *  inline error, verbatim. */
function bashDiagnostic(raw: string): PolicyEntryDiagnostic | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { severity: 'error', message: 'Empty pattern — the engine skips it.' };
  }
  if (trimmed.length > MAX_BASH_PATTERN_LENGTH) {
    return {
      severity: 'error',
      message: `Over the ${MAX_BASH_PATTERN_LENGTH}-character cap — the engine skips this pattern entirely.`,
    };
  }
  const compiled = compileBashPattern(trimmed);
  if (compiled.error !== undefined) {
    return {
      severity: 'error',
      message: `Not a valid regex, so the engine skips it: ${compiled.error}`,
    };
  }
  if (trimmed.length > 2 && trimmed.startsWith('/') && trimmed.endsWith('/')) {
    return {
      severity: 'warning',
      message:
        'The surrounding `/` are matched literally — this field holds the pattern body, not a `/…/` regex literal.',
    };
  }
  if (PATH_GLOB_SHAPE.test(trimmed)) {
    return {
      severity: 'warning',
      message:
        'This looks like a glob, but the field is a JS regex — `*` repeats the PREVIOUS character (`.env*` matches `.en`, `.env`, `.envv`…). Escape literal dots (`\\.env`) or write a plain substring.',
    };
  }
  return null;
}

/** Diagnostics for an exact-match tool tier (`disallowedTools` / `askTools`).
 *  These tiers compare the SDK tool NAME, so permission-rule syntax and stray
 *  wildcards are provably dead — the most common silent failure in the whole
 *  policy block. */
function toolDiagnostic(raw: string): PolicyEntryDiagnostic | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { severity: 'error', message: 'Empty entry — the engine skips it.' };
  }
  if (trimmed.includes('(')) {
    return {
      severity: 'error',
      message:
        'This tier matches the bare tool NAME, so a permission rule like `Bash(git push:*)` never matches. Name the tool (`Bash`), or put the rule under Auto-allowed rules.',
    };
  }
  if (trimmed.includes('*') && !isMcpGlobEntry(trimmed)) {
    return {
      severity: 'error',
      message:
        'Only an `mcp__<server>__*` entry globs — every other `*` is matched literally, so this never fires.',
    };
  }
  if (trimmed.startsWith('mcp__')) return null;
  if (NATIVE_SDK_TOOLS.includes(trimmed)) return null;
  const caseVariant = NATIVE_SDK_TOOLS.find(
    (tool) => tool.toLowerCase() === trimmed.toLowerCase(),
  );
  if (caseVariant !== undefined) {
    return {
      severity: 'error',
      message: `Tool names are case-sensitive — this never matches. Did you mean \`${caseVariant}\`?`,
    };
  }
  return {
    severity: 'warning',
    message:
      'Not a known built-in tool name. Matching is exact and case-sensitive; an MCP tool must be spelled `mcp__<server>__<tool>`.',
  };
}

/** Diagnostics for an `allowTools` entry — a VERBATIM SDK permission-rule
 *  string, so only structural nonsense can be judged here. Deliberately lenient:
 *  the SDK owns the rule grammar and this tier can never restrict a session. */
function permissionRuleDiagnostic(raw: string): PolicyEntryDiagnostic | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { severity: 'error', message: 'Empty entry — the engine skips it.' };
  }
  const open = (trimmed.match(/\(/g) ?? []).length;
  const close = (trimmed.match(/\)/g) ?? []).length;
  if (open !== close) {
    return {
      severity: 'error',
      message: 'Unbalanced parentheses — the SDK cannot parse this permission rule.',
    };
  }
  if (trimmed.startsWith('(')) {
    return {
      severity: 'error',
      message: 'A permission rule starts with the tool name, e.g. `Bash(git status:*)`.',
    };
  }
  return null;
}

/**
 * The single entry point: diagnose one raw policy entry for its tier, or `null`
 * when nothing is wrong. Called per keystroke by the editor (cheap: string
 * checks plus at most one `new RegExp`) and by the engine's compile wrappers so
 * both sides describe a dead rule identically.
 */
export function diagnosePolicyEntry(
  kind: PolicyEntryKind,
  raw: string,
): PolicyEntryDiagnostic | null {
  switch (kind) {
    case 'path':
      return pathDiagnostic(raw);
    case 'bash-regex':
      return bashDiagnostic(raw);
    case 'tool':
      return toolDiagnostic(raw);
    case 'permission-rule':
      return permissionRuleDiagnostic(raw);
  }
}
