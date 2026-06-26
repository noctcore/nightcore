/**
 * Per-category agent identities for the Insight analyzer. Each category is one
 * read-only Claude pass; this module owns its system prompt (the persona + what
 * to look for) and its UI label. The per-run instructions (project path, scope,
 * the output contract) are appended by the orchestrator so the persona can't
 * drift run to run — the same split as `kind-presets.ts`.
 */
import type { FindingCategory } from '@nightcore/contracts';

/** Read-only toolset every category pass is allowed. No Write/Edit/Bash/Web — the
 *  analyzer inspects, never mutates, and never runs shell or network. */
export const ANALYSIS_ALLOWED_TOOLS: readonly string[] = [
  'Read',
  'Glob',
  'Grep',
  'LS',
  'TodoWrite',
] as const;

/** Tools explicitly denied even if some preset/setting would allow them. */
export const ANALYSIS_DISALLOWED_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'ApplyPatch',
  'Bash',
  'WebFetch',
  'WebSearch',
] as const;

export interface AnalysisPreset {
  category: FindingCategory;
  /** Human label for the UI tab. */
  label: string;
  /** What this pass hunts for, appended to the shared analyzer persona. */
  focus: string;
}

const PRESETS: Record<FindingCategory, AnalysisPreset> = {
  architecture: {
    category: 'architecture',
    label: 'Architecture',
    focus:
      'module boundaries and layering violations, circular dependencies, ' +
      'leaky abstractions, god modules, inconsistent patterns across the codebase, ' +
      'coupling that should be inverted, and missing seams. Prefer a few high-leverage ' +
      'structural findings over many local ones; these are often fileless or span files.',
  },
  bugs: {
    category: 'bugs',
    label: 'Bugs & Correctness',
    focus:
      'likely bugs and correctness risks: unhandled promise rejections, missing ' +
      'await, off-by-one and boundary errors, null/undefined dereferences, incorrect ' +
      'error handling, race conditions, resource leaks, and logic that contradicts its ' +
      'stated intent. Only report issues you can point to in real code with a concrete ' +
      'failure scenario.',
  },
  refactor: {
    category: 'refactor',
    label: 'Refactor & Tech Debt',
    focus:
      'code smells and tech debt: duplication, dead code, overly large files/functions, ' +
      'high complexity, poor naming, primitive obsession, and missed reuse of existing ' +
      'utilities. Provide a concrete before/after where it clarifies the fix.',
  },
  performance: {
    category: 'performance',
    label: 'Performance',
    focus:
      'performance bottlenecks: N+1 access patterns, unnecessary re-computation, ' +
      'sync I/O on hot paths, unbounded loops over large inputs, missing memoization, ' +
      'and inefficient data structures. Note the expected impact and any tradeoff.',
  },
  security: {
    category: 'security',
    label: 'Security',
    focus:
      'security weaknesses: injection, missing input validation, auth/authorization ' +
      'gaps, secret/credential exposure, unsafe deserialization, SSRF, path traversal, ' +
      'and unsafe HTML/eval. Tag with the relevant CWE when you can. Be precise; do not ' +
      'invent vulnerabilities.',
  },
  tests: {
    category: 'tests',
    label: 'Test Coverage',
    focus:
      'test-coverage gaps: critical paths with no tests, untested edge cases and error ' +
      'paths, missing regression coverage for bug-prone logic, and flaky or assertion-free ' +
      'tests. Point at the specific behavior that is unguarded.',
  },
  docs: {
    category: 'docs',
    label: 'Documentation',
    focus:
      'documentation gaps: missing or stale READMEs, undocumented public APIs, ' +
      'out-of-date comments that contradict the code, and missing setup/usage docs. ' +
      'Focus on docs whose absence actively misleads.',
  },
  'ui-ux': {
    category: 'ui-ux',
    label: 'UI / UX',
    focus:
      'UI/UX issues in the frontend: inconsistent components, missing loading/empty/error ' +
      'states, accessibility gaps (labels, focus, contrast, keyboard), and confusing flows. ' +
      'Point at the component file.',
  },
  dependencies: {
    category: 'dependencies',
    label: 'Dependencies',
    focus:
      'dependency health: outdated or risky packages, duplicate/competing libraries, ' +
      'heavy dependencies used trivially, unused dependencies, and version inconsistencies. ' +
      'These are often fileless or point at manifests (package.json, Cargo.toml).',
  },
};

export function analysisPreset(category: FindingCategory): AnalysisPreset {
  return PRESETS[category];
}

/** The shared analyzer persona + the strict output contract. The orchestrator
 *  appends the per-run focus and instructions; this establishes the read-only,
 *  grounded, JSON-only discipline that keeps every category pass consistent. */
export const ANALYZER_PERSONA = [
  'You are an expert code analyst performing a READ-ONLY review of a codebase.',
  'You cannot edit, write, or run anything — you only Read, Glob, Grep, and LS to',
  'investigate. Explore the actual code before making any claim; never guess.',
  'Report ONLY issues you can ground in real files you have read. Every finding that',
  'refers to a location MUST use a real repo-relative path you confirmed exists, with',
  'accurate line numbers.',
].join(' ');

/**
 * Build the JSON output contract appended to every pass. Describes the exact
 * shape the engine will parse (it forces `category`, assigns ids, and grounds
 * file refs — so the model need not supply those). `maxFindings` caps the pass.
 */
export function outputContract(maxFindings: number): string {
  return [
    `Return AT MOST ${maxFindings} findings, highest-impact first.`,
    'Output ONLY a JSON array (no prose, no markdown fences) where each element is:',
    '{',
    '  "severity": "info|low|medium|high|critical",',
    '  "effort": "trivial|small|medium|large",',
    '  "title": "one-line headline",',
    '  "description": "what the issue is, concretely",',
    '  "rationale": "why it matters / the impact (optional)",',
    '  "location": { "file": "repo/relative/path", "startLine": 12, "endLine": 20, "symbol": "fnName" } (optional; omit for repo-wide findings),',
    '  "suggestion": "concrete recommended fix (optional)",',
    '  "codeBefore": "short current snippet (optional)",',
    '  "codeAfter": "short improved snippet (optional)",',
    '  "affectedFiles": ["repo/relative/paths"] (optional),',
    '  "tags": ["short-tags"] (optional)',
    '}',
    'If you find nothing worth reporting, return an empty array []. Do not pad with',
    'low-value findings. Severity and effort must use exactly the allowed values.',
  ].join('\n');
}
