/**
 * Prompt + persona builders for the Harness synthesis pass: the SYNTHESIZING analyzer
 * persona and the user prompt that carries the hardening playbook, repo profile, repo
 * map, convention findings, and the JSON output contracts (artifacts + task-shaped
 * proposals + the Drift-v1 compiled-check contract). Pure string composition — no session
 * or SDK. The advertised caps are imported from the modules that enforce them so the
 * "propose at most N" instruction and the grounding limit are one constant.
 */
import type {
  ConventionFinding,
  RepoProfile,
  SurfaceCommand,
} from '@nightcore/contracts';

import { ANALYZER_PERSONA } from './presets.js';
import { hardeningReference, HARNESS_REFERENCE } from './reference.js';
import { MAX_ARTIFACTS } from './synthesis-artifacts.js';
import { MAX_PROPOSALS } from './synthesis-parse.js';

type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

/** The synthesis persona — the read-only analyzer, now asked to PROPOSE (never
 *  write) an enforceable harness as JSON content. The string literally says
 *  "SYNTHESIZING" so a test fake can route this session distinctly. */
export const SYNTHESIS_PERSONA = [
  ANALYZER_PERSONA,
  'You are now SYNTHESIZING an enforceable harness from the conventions found.',
  'You STILL never write or edit files — you return the proposed file CONTENT as',
  'JSON; the host applies it. Inspect the repo to make the rules accurate.',
].join(' ');

/** Compose the synthesis user prompt: reference + profile summary + findings +
 *  the artifact output contract. The `inventory` (deterministic top-level repo map)
 *  is built once by the harness manager and threaded in to avoid a second fs walk. */
export function buildSynthesisPrompt(
  profile: RepoProfile,
  findings: ConventionFinding[],
  inventory: string,
  command: StartHarnessScan,
): string {
  return [
    `You are designing an enforceable harness for the project at: ${command.projectPath}`,
    '',
    HARNESS_REFERENCE,
    '',
    hardeningReference(profile),
    '',
    'REPO PROFILE (deterministically detected):',
    summarizeProfile(profile),
    '',
    'REPO MAP (deterministic top-level inventory — start from this, do not re-list the tree):',
    inventory,
    '',
    'CONVENTION FINDINGS to enforce (reference these by fingerprint in sourceFindings):',
    summarizeFindings(findings),
    '',
    artifactOutputContract(profile),
  ].join('\n');
}

/** A compact, model-readable summary of the repo profile. Exported so the lens
 *  passes (harness-manager) ground each prompt on the SAME profile summary. */
export function summarizeProfile(profile: RepoProfile): string {
  const lines = [
    `- monorepo: ${profile.isMonorepo} (workspace tool: ${profile.workspaceTool})`,
    `- packages: ${
      profile.packages.length > 0
        ? profile.packages.map((p) => `${p.name} [${p.role}] (${p.path})`).join(', ')
        : 'none'
    }`,
    `- languages: ${profile.languages.join(', ') || 'unknown'}`,
    `- frameworks: ${profile.frameworks.join(', ') || 'none detected'}`,
    `- eslint flat config: ${profile.hasEslintFlatConfig}`,
    `- lint-meta engine: ${profile.hasLintMeta}`,
    `- agent docs: ${profile.hasAgentDocs}`,
    `- existing eslint plugins: ${profile.existingPlugins.join(', ') || 'none'}`,
  ];
  return lines.join('\n');
}

/** A compact list of findings (fingerprint + kind + title + suggestion). */
function summarizeFindings(findings: ConventionFinding[]): string {
  if (findings.length === 0) return '- (no convention findings)';
  return findings
    .map((f) => {
      const tail = f.suggestion !== undefined ? ` → ${f.suggestion}` : '';
      return `- (${f.fingerprint}) [${f.category}/${f.kind}] ${f.title}${tail}`;
    })
    .join('\n');
}

/** The JSON contract for the proposed artifacts. */
function artifactOutputContract(profile: RepoProfile): string {
  const eslintAllowed = profile.isMonorepo || profile.hasEslintFlatConfig;
  return [
    'Propose the harness as a JSON array (no prose, no markdown fences) where each',
    'element is:',
    '{',
    '  "kind": "lint-meta-rule|eslint-rule|eslint-plugin-file|eslint-config|agent-contract|custom-lint-plugin|tool-config",',
    '  "group": "optional group id; share it across files that ship together",',
    '  "groupTitle": "optional human label for the group",',
    '  "title": "one-line headline",',
    '  "description": "what this artifact is / does",',
    '  "rationale": "why, tied to the conventions it enforces (optional)",',
    '  "targetPath": "repo/relative/destination/path",',
    '  "writeMode": "create|merge-section",',
    '  "content": "the FULL file content (create) or the managed-section body (merge-section)",',
    '  "language": "typescript|markdown|json (optional)",',
    '  "sourceFindings": ["fingerprints of the findings this enforces"],',
    '  "dependsOn": ["ids of artifacts this one needs (optional)"]',
    '}',
    eslintAllowed
      ? [
          'CUSTOM LINT PLUGIN — when the conventions are concrete enough to enforce',
          'with AST rules, generate a project-specific ESLint plugin as a multi-file',
          'BUNDLE: emit SEVERAL `eslint-plugin-file` artifacts that ALL share one',
          '`group:"eslint-plugin"` (and the same `groupTitle`), namely:',
          '  - a scaffold `index.js` that re-exports `{ rules }` (the plugin entry),',
          '  - ONE file per rule under `rules/<rule-name>.js` (a real AST rule:',
          '    `meta` + `create(context)` returning a selector→`context.report` visitor,',
          '    with an optional `fix` when the change is mechanical),',
          '  - a `tests/<rule-name>.test.js` fixture exercising the rule so the plugin',
          '    self-verifies (valid + invalid cases) — derive each rule + fixture from a',
          '    specific convention finding and cite it in `sourceFindings`.',
          'Make each rule file `dependsOn` the scaffold `index.js` id so the scaffold',
          'is written first. ADDITIONALLY emit ONE `custom-lint-plugin` artifact sharing',
          'the SAME `group` — a short `agent-contract`-style or `markdown` summary',
          '(e.g. `<plugin-dir>/README.md`) that LABELS the bundle as a generated lint',
          'plugin and lists its rules; this is the group header the UI surfaces.',
          'A simpler one-off ESLint rule that is NOT a full plugin stays a single',
          '`eslint-plugin-file` with no `custom-lint-plugin` companion.',
        ].join('\n')
      : 'This repo has no monorepo/eslint host: prefer an `agent-contract` plus minimal rules; do NOT scaffold a full plugin package or a `custom-lint-plugin` bundle.',
    'CLAUDE.md / AGENTS.md guardrail docs use `agent-contract` + `writeMode:"merge-section"`.',
    '`tool-config` is a standalone hardening config file (see HARDENING MODULES above),',
    'always `writeMode:"create"` at a path that does not exist yet.',
    'Every `targetPath` MUST be repo-relative (no leading `/`, no `..`).',
    `Propose at most ${MAX_ARTIFACTS} artifacts.`,
    '',
    proposalOutputContract(eslintAllowed),
  ].join('\n');
}

/** The JSON contract for the task-shaped proposals. Proposals ride ALONGSIDE the
 *  artifacts in an object envelope; a bare artifacts array is still accepted (→ no
 *  proposals) so an older-style answer never fails the parse. */
function proposalOutputContract(eslintAllowed: boolean): string {
  return [
    'Return your whole answer as a JSON OBJECT with two arrays (no prose, no fences):',
    '{ "artifacts": [ …the artifacts above… ], "proposals": [ …see below… ] }',
    '',
    'A PROPOSAL is a task-shaped recommendation the user turns into ONE board task. Each is:',
    '{',
    '  "kind": "apply-artifacts | agent-task",',
    '  "title": "one-line headline (becomes the task title)",',
    '  "description": "what to do, concretely (becomes the task body)",',
    '  "rationale": "why it matters / what an agent breaks without it (optional)",',
    '  "artifactIds": ["ids of the artifacts this bundles"]  // apply-artifacts ONLY,',
    '  "prompt": "the instruction for the agent to perform"   // agent-task ONLY,',
    '  "verifyCommand": "a command that MUST pass when done, e.g. npx eslint ."  // agent-task, optional,',
    '  "harnessCheck": { "name": "…", "kind": "lint-meta | shell | lint-plugin", "command": "…", "conventionFingerprint": "…" }  // optional',
    '}',
    driftCompileContract(),
    'Use `apply-artifacts` for changes that are safe to write straight to disk (new docs,',
    'a new lint config file, a generated plugin BUNDLE): set `artifactIds` to the ids of',
    'the artifacts that ship together (group members share one proposal).',
    eslintAllowed
      ? 'Use `agent-task` for changes that must NOT be a blind write — WIRING the generated plugin into `eslint.config.*`, editing `package.json` scripts, adding a pre-commit hook: describe the change in `prompt`, and set `verifyCommand` to the command that proves it works (e.g. the lint command). These become worktree Build tasks a human reviews as a diff — never a direct file write.'
      : 'This repo has no eslint host: prefer `apply-artifacts` proposals for the docs/rules; use `agent-task` only for a genuinely execution-adjacent change.',
    `Return "proposals": [] if there is nothing worth proposing. At most ${MAX_PROPOSALS} proposals.`,
  ].join('\n');
}

/** The Drift-v1 (T15) compiled-check contract: for a convention the codebase ALREADY
 *  follows and that can be verified DETERMINISTICALLY, compile a check so a later run
 *  can measure whether the convention still holds at every site. Deliberately narrow:
 *  the v0.3 substrate is lint-meta rules + shell/ripgrep counts ONLY, and a check is
 *  only ever a SUGGESTION a human reviews and arms — synthesis never arms anything. */
function driftCompileContract(): string {
  return [
    '',
    'COMPILE DRIFT CHECKS (only for conventions the repo ALREADY follows):',
    'For each CONVENTION finding above (kind = convention, not a gap) that you are',
    'CONFIDENT can be verified by a DETERMINISTIC, mechanical check, compile ONE check',
    'and attach it to the proposal as its `harnessCheck`. Set `conventionFingerprint` to',
    "that convention's EXACT fingerprint — the `(<fingerprint>)` prefix in the findings",
    'list above. Two substrates ONLY (v0.3). The arm gate SHAPE-VALIDATES these commands,',
    'so emit EXACTLY the allowed form or the check will be refused arming:',
    '  - STRUCTURAL / PATH / NAMING / FOLDER conventions → a lint-meta rule. Emit a',
    '    `lint-meta-rule` artifact holding the rule body, reference it from an',
    '    `apply-artifacts` proposal, and give that proposal a `harnessCheck` with',
    '    `kind:"lint-meta"`, its `name` set to the rule id, and a `command` that is a',
    '    package-script invocation ONLY: `<pm> run <script>` (e.g. `bun run lint:meta`).',
    '    NEVER `npx`/`bunx`/`pnpm dlx`/`deno`/`node`, and never run a file path — only an',
    '    existing package.json script name.',
    '  - TEXTUAL / CONTENT conventions (a required/forbidden token, import form, header)',
    '    → a shell check. Use an `agent-task` proposal whose `harnessCheck` has',
    '    `kind:"shell"` and a `command` that COUNTS violating sites with `rg`/`grep` ONLY,',
    "    e.g. `rg --count-matches 'pattern' src` or `rg -c 'pattern' src`. NO shell",
    '    metacharacters (semicolon, pipe, ampersand, dollar, backtick, redirects,',
    '    parens, braces) and no subprocess/file flags (`--pre`, `--hostname-bin`,',
    '    `--search-zip`, `-f`/`--file`) — a plain count only.',
    'ONLY compile a check you can express as a deterministic rule/command. If a convention',
    'needs human judgement or a semantic read to verify, SKIP it — do NOT invent a check;',
    'it simply stays unmeasured (honest). Do NOT use ESLint rules or ast-grep for drift',
    'checks in v0.3. Every compiled check is a SUGGESTION reviewed and armed by a human —',
    'never assume it runs, and never propose auto-arming it.',
  ].join('\n');
}
