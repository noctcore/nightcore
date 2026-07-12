/**
 * Per-lens agent identities for the Harness convention auditor. Each
 * {@link ConventionCategory} is one read-only Claude pass; this module owns its
 * focus string (what convention/gap to hunt) and its UI label. The per-run
 * instructions (project path, the output contract) are appended by the
 * orchestrator so the persona can't drift run to run — the same split as
 * `analysis-presets.ts`.
 *
 * The read-only toolset + analyzer persona are SHARED with Insight (re-exported
 * from `analysis-presets.ts`, not duplicated) so both features inspect the repo
 * under the identical Read/Glob/Grep/LS-only discipline.
 */
import type { ConventionCategory } from '@nightcore/contracts';

export {
  ANALYSIS_ALLOWED_TOOLS,
  ANALYSIS_DISALLOWED_TOOLS,
  ANALYZER_PERSONA,
} from '../shared/presets.js';

export interface HarnessPreset {
  category: ConventionCategory;
  /** Human label for the UI section. */
  label: string;
  /** What this pass hunts for, appended to the shared analyzer persona. */
  focus: string;
}

const PRESETS: Record<ConventionCategory, HarnessPreset> = {
  architecture: {
    category: 'architecture',
    label: 'Architecture',
    focus:
      'the de-facto module/layer boundaries and the direction dependencies are ' +
      'allowed to flow. Identify where the real architecture lives (which layer ' +
      'owns what, what may import what) and where files VIOLATE it. State each as ' +
      'an enforceable rule; these are often fileless or span many files.',
  },
  'folder-structure': {
    category: 'folder-structure',
    label: 'Folder Structure',
    focus:
      'how directories and modules are organized and what colocation conventions ' +
      'hold (e.g. folder-per-component: each component in its own folder with its ' +
      'styles/tests/index). Identify the dominant layout and the files that ' +
      'deviate from it.',
  },
  naming: {
    category: 'naming',
    label: 'Naming',
    focus:
      'the file and symbol naming conventions in force (file casing/suffixes, ' +
      'type/function/constant casing, resource-prefix patterns) and the concrete ' +
      'deviations. State the rule a name must satisfy.',
  },
  'imports-boundaries': {
    category: 'imports-boundaries',
    label: 'Imports & Boundaries',
    focus:
      'the cross-module / cross-feature import rules: which directions are allowed ' +
      'and which are forbidden (no upward imports, no cross-feature imports, no ' +
      'reaching past a public barrel), and the barrel/index conventions. State each ' +
      'allowed/forbidden import direction as a rule.',
  },
  'design-decisions': {
    category: 'design-decisions',
    label: 'Design Decisions',
    focus:
      'the recurring design decisions worth codifying: state management, error ' +
      'handling, data access, async/concurrency patterns, and how new code is ' +
      'expected to follow them. Capture the decision AS A RULE so an agent applies ' +
      'it consistently.',
  },
  'tooling-lint': {
    category: 'tooling-lint',
    label: 'Tooling & Lint',
    focus:
      'the existing lint / eslint / lint-meta setup: what is configured, whether ' +
      'rules are actually enforced (error vs warn vs off), how the monorepo wires ' +
      'configs per package, and the gaps where conventions are unenforced. Point at ' +
      'the config files. Also flag supply-chain / secret-hygiene tooling gaps (no ' +
      'secret-scan config, dependency lifecycle scripts unpinned, no lockfile check) ' +
      '— they ground the hardening modules synthesis proposes.',
  },
  testing: {
    category: 'testing',
    label: 'Testing',
    focus:
      'the test conventions: where tests live (colocated vs a tests dir), how they ' +
      'are named, which framework/runner is used, and the coverage discipline for ' +
      'critical paths. State the convention new tests must follow. When a heavily ' +
      'imported module has little or no coverage, NAME it (real files only) — those ' +
      'anchors are what makes a characterization-test proposal honest.',
  },
  'agent-context': {
    category: 'agent-context',
    label: 'Agent Context',
    focus:
      'whether the conventions are written down for AI agents: the presence and ' +
      'quality of CLAUDE.md / AGENTS.md / AGENT_CONTRACT.md, whether they match the ' +
      'real code, and which guardrails an agent would NOT learn from the docs ' +
      'alone. Flag missing or stale agent context as a gap.',
  },
};

export function harnessPreset(category: ConventionCategory): HarnessPreset {
  return PRESETS[category];
}

/**
 * Build the JSON output contract appended to every convention pass. Describes the
 * exact shape the engine will parse (it forces `category`, assigns ids, grounds
 * file refs — so the model need not supply those). `maxFindings` caps the pass.
 * In deep mode's round ≥ 2 (`newOnly`), the lead line demands NEW conventions/gaps
 * not already listed in the round's exclusion block, so each round elicits distinct
 * findings rather than re-reporting the ones prior rounds already found.
 */
export function conventionOutputContract(maxFindings: number, newOnly = false): string {
  return [
    newOnly
      ? `Return AT MOST ${maxFindings} **NEW** convention findings **not already listed above**, highest-signal first.`
      : `Return AT MOST ${maxFindings} convention findings, highest-signal first.`,
    'Output ONLY a JSON array (no prose, no markdown fences) where each element is:',
    '{',
    '  "kind": "convention|gap",',
    '  "severity": "info|low|medium|high|critical",',
    '  "title": "the convention or gap, stated as an enforceable RULE",',
    '  "description": "what the convention/gap is, concretely",',
    '  "rationale": "what an agent breaks if it ignores this (optional)",',
    '  "evidence": [{ "file": "repo/relative/path", "startLine": 12, "endLine": 20, "symbol": "name" }] (optional; OMIT for a repo-wide / fileless convention),',
    '  "suggestion": "the concrete rule to codify, or the change to adopt (optional)",',
    '  "tags": ["short-tags"] (optional)',
    '}',
    'Report the DE-FACTO convention AS A RULE so it can be codified and ENFORCED —',
    'not as a vague observation. `convention` = a rule the codebase already follows',
    '(codify + enforce it); `gap` = a best practice it is missing (propose adopting',
    'it). Ground every evidence path in a real file you have read; omit evidence',
    'entirely for a genuinely repo-wide convention rather than inventing a file.',
    'If you find nothing worth reporting, return an empty array [].',
  ].join('\n');
}
