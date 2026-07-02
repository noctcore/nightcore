/**
 * Per-dimension agent identities for the Readiness Scorecard grader. Each dimension
 * is one read-only Claude pass; this module owns its system prompt (the persona +
 * the grading rubric), its UI label, and the `hardenSkill` slash-command the
 * "Harden this" button dispatches as a Build task. The per-run instructions
 * (project path, the repo map, the output contract) are appended by the
 * orchestrator so the persona can't drift run to run — the same split as
 * `analysis-presets.ts`.
 *
 * The read-only toolset + analyzer persona are REUSED VERBATIM from
 * `analysis-presets.ts` (the grading pass inspects, never mutates), so the two
 * features share one read-only discipline.
 */
import type { ScorecardDimension } from '@nightcore/contracts';

export {
  ANALYSIS_ALLOWED_TOOLS as SCORECARD_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS as SCORECARD_DISALLOWED_TOOLS,
} from '../shared/presets.js';

export interface ScorecardPreset {
  dimension: ScorecardDimension;
  /** Human label for the UI row. */
  label: string;
  /** What this pass grades + the A–F thresholds, appended to the analyzer persona.
   *  Pinned per-dimension so the model maps evidence to a letter against fixed
   *  criteria rather than freestyling it. */
  rubric: string;
  /** The slash-command the "Harden this" button mints as a Build task prompt (it
   *  leverages a skill the SDK already loaded, e.g. `/security-audit`). */
  hardenSkill: string;
}

/** The shared A–F scale, restated in every rubric so each pass anchors on the same
 *  letter meaning before applying its dimension-specific thresholds. */
const GRADE_SCALE =
  'Grade on this scale: A = exemplary, production-grade; B = solid with minor gaps; ' +
  'C = adequate but with real gaps; D = weak, multiple material gaps; ' +
  'E = poor, largely unaddressed; F = absent or actively harmful.';

const PRESETS: Record<ScorecardDimension, ScorecardPreset> = {
  architecture: {
    dimension: 'architecture',
    label: 'Architecture',
    hardenSkill: '/audit',
    rubric:
      'Grade the ARCHITECTURE: module boundaries and layering, separation of ' +
      'concerns, coupling/cohesion, consistent patterns, and absence of god modules ' +
      'or circular dependencies. A = clean, enforced boundaries with clear seams; ' +
      'C = workable but with leaky abstractions or some tangling; F = no discernible ' +
      'structure. Anchor evidence in real files.',
  },
  tests: {
    dimension: 'tests',
    label: 'Tests',
    hardenSkill: '/write-tests',
    rubric:
      'Grade the TEST COVERAGE and quality: critical paths covered, edge/error cases ' +
      'tested, meaningful assertions, regression coverage for bug-prone logic. ' +
      'A = critical paths and edge cases well covered with strong assertions; ' +
      'C = happy-path only with notable gaps; F = no meaningful tests. Point at the ' +
      'unguarded behavior. FIRST look for mutation-testing evidence ' +
      '(reports/mutation/mutation.json, a stryker.conf.* file, a .stryker-tmp/ dir, ' +
      'or a stryker config block): when a mutation report exists, ground the grade ' +
      'in the MUTATION SCORE — killed vs survived mutants measure assertion ' +
      'strength, which raw line coverage cannot — and cite the score you read.',
  },
  security: {
    dimension: 'security',
    label: 'Security',
    hardenSkill: '/security-audit',
    rubric:
      'Grade the SECURITY posture: input validation, auth/authorization, secret ' +
      'handling, injection/SSRF/path-traversal exposure, unsafe deserialization. ' +
      'A = inputs validated, authz enforced, no exposed secrets; C = some validation ' +
      'gaps or weak authz; F = exploitable holes. Tag CWE where you can; never invent ' +
      'vulnerabilities.',
  },
  'error-handling': {
    dimension: 'error-handling',
    label: 'Error Handling',
    hardenSkill: '/add-empty-error-states',
    rubric:
      'Grade ERROR HANDLING: errors caught and surfaced (not swallowed), graceful ' +
      'degradation, no unhandled rejections, user-facing error states. A = errors ' +
      'handled and surfaced consistently with degrade-not-throw; C = inconsistent, ' +
      'some swallowed errors; F = errors crash or vanish silently.',
  },
  observability: {
    dimension: 'observability',
    label: 'Observability',
    hardenSkill: '/add-observability',
    rubric:
      'Grade OBSERVABILITY: structured logging, error/exception reporting, tracing/' +
      'metrics on critical paths, and the ability to debug a production incident from ' +
      'signals. A = structured logs + error reporting + key metrics; C = ad-hoc ' +
      'console logging only; F = no signals at all.',
  },
  dependencies: {
    dimension: 'dependencies',
    label: 'Dependencies',
    hardenSkill: '/audit',
    rubric:
      'Grade DEPENDENCY health: up-to-date and unduplicated packages, no known-risky ' +
      'or unused deps, pinned/lockfiled versions, lean footprint. A = current, lean, ' +
      'no duplicates or CVEs; C = some outdated or duplicate libraries; F = many ' +
      'stale/risky deps. These often point at manifests (package.json, Cargo.toml).',
  },
  performance: {
    dimension: 'performance',
    label: 'Performance',
    hardenSkill: '/audit-perf',
    rubric:
      'Grade PERFORMANCE: absence of N+1 access, unnecessary recomputation, sync I/O ' +
      'on hot paths, unbounded loops over large inputs, and appropriate memoization/' +
      'data structures. A = hot paths are efficient and bounded; C = some avoidable ' +
      'overhead; F = obvious bottlenecks on critical paths.',
  },
  types: {
    dimension: 'types',
    label: 'Type Safety',
    hardenSkill: '/harden-types',
    rubric:
      'Grade TYPE SAFETY: minimal `any`/unsafe casts, no `@ts-ignore` on real errors, ' +
      'typed boundaries (HTTP/IPC/env validated), and exported APIs annotated. ' +
      'A = strict, validated boundaries with almost no escape hatches; C = scattered ' +
      '`any`/casts; F = pervasive untyped surfaces.',
  },
  a11y: {
    dimension: 'a11y',
    label: 'Accessibility',
    hardenSkill: '/audit-a11y',
    rubric:
      'Grade ACCESSIBILITY of the frontend: semantic markup, labels/roles, keyboard ' +
      'operability, focus management, and color contrast. A = keyboard-operable, ' +
      'labeled, focus-managed; C = partial labels/keyboard support; F = inaccessible. ' +
      'Point at the component file. Grade A (not applicable→A) if there is no UI.',
  },
  'docs-ci': {
    dimension: 'docs-ci',
    label: 'Docs & CI',
    hardenSkill: '/sync-docs',
    rubric:
      'Grade DOCUMENTATION and CI: an accurate README/setup docs, documented public ' +
      'APIs, and an automated CI pipeline (lint/typecheck/test gates). A = clear docs ' +
      '+ enforced CI gates; C = thin docs or partial CI; F = neither. Note missing ' +
      'config files (CI workflow, README) explicitly.',
  },
};

export function scorecardPreset(dimension: ScorecardDimension): ScorecardPreset {
  return PRESETS[dimension];
}

/**
 * Build the JSON output contract appended to every grading pass. Describes the
 * exact single-object shape the engine parses: ONE grade for the dimension plus the
 * grounded evidence it rests on (the engine assigns ids + fingerprints and grounds
 * file refs, so the model need not supply those).
 */
export function readingOutputContract(maxEvidence: number): string {
  return [
    GRADE_SCALE,
    `Return AT MOST ${maxEvidence} evidence items, highest-impact first.`,
    'Output ONLY a JSON object (no prose, no markdown fences) of exactly:',
    '{',
    '  "grade": "A|B|C|D|E|F",',
    '  "title": "one-line headline for this dimension",',
    '  "summary": "the graded assessment, concretely — what holds it at this letter",',
    '  "rationale": "what would move it up a letter (optional)",',
    '  "location": { "file": "repo/relative/path", "startLine": 12, "endLine": 20, "symbol": "fnName" } (optional primary anchor),',
    '  "suggestion": "the single highest-leverage action to raise the grade (optional)",',
    '  "affectedFiles": ["repo/relative/paths"] (optional),',
    '  "tags": ["short-tags"] (optional),',
    '  "findings": [ { "detail": "one concrete observation", "location": { "file": "repo/relative/path", "startLine": 12 } } ] (the grounded evidence; location optional per item)',
    '}',
    'The grade MUST be exactly one of A,B,C,D,E,F. Ground every file ref in a real',
    'file you read. Do not pad evidence with low-value items.',
  ].join('\n');
}
