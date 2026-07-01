import { z } from 'zod';
import { FindingLocationSchema, FindingSeveritySchema } from './insight.js';

/**
 * `@nightcore/contracts` — Harness (codebase convention auditor) shapes.
 *
 * Where Insight scans a repo for fixable issues, Harness scans it for its
 * CONVENTIONS — how it is architected, organized, and named — then proposes an
 * enforceable "harness" so AI agents stop breaking those conventions: a set of
 * generated ESLint rules + a `lint-meta` manifest + a CLAUDE.md / AGENTS.md
 * contract. The scan runs as read-only category passes that each emit structured
 * {@link ConventionFindingSchema} items (grounded against real files), and a final
 * synthesis pass turns the profile + findings into {@link ProposedArtifactSchema}
 * items the user previews and applies one file at a time.
 *
 * Reuses {@link FindingLocationSchema} / {@link FindingSeveritySchema} from
 * `insight.ts` so file anchors and the severity scale stay unified across both
 * features (and collapse to the same generated Rust types). Zod-only: imports
 * nothing from `commands.ts`/`events.ts` so those can reference these schemas
 * without a cycle.
 */

/** The convention "lenses". Each is one read-only pass and one UI section. Wire
 *  strings are kebab-case so they survive codegen as clean enum variants. */
export const ConventionCategorySchema = z.enum([
  'architecture',
  'folder-structure',
  'naming',
  'imports-boundaries',
  'design-decisions',
  'tooling-lint',
  'testing',
  'agent-context',
]);
export type ConventionCategory = z.infer<typeof ConventionCategorySchema>;

/** Whether a finding records a convention the codebase ALREADY follows
 *  (`convention` — codify + enforce it) or a GAP against best practice
 *  (`gap` — propose adopting it). */
export const ConventionKindSchema = z.enum(['convention', 'gap']);
export type ConventionKind = z.infer<typeof ConventionKindSchema>;

/**
 * One grounded convention finding. Mirrors Insight's `Finding` but repo-pattern
 * shaped: `evidence` is a LIST of file anchors (a convention is a repo-wide
 * pattern, not a single line), and `kind` separates an observed rule from a
 * missing best practice. The lifecycle field (status) is NOT here — it is owned
 * by the Rust `HarnessStore`, applied on persist.
 */
export const ConventionFindingSchema = z.object({
  /** Stable id assigned by the engine (dedup, dismiss, UI keys). */
  id: z.string(),
  category: ConventionCategorySchema,
  kind: ConventionKindSchema,
  severity: FindingSeveritySchema,
  /** One-line headline (the convention or gap, stated as a rule). */
  title: z.string(),
  /** What the convention/gap is, concretely. */
  description: z.string(),
  /** Why it matters / what an agent breaks if it ignores this. */
  rationale: z.string().optional(),
  /** Repo-relative file anchors the finding is grounded in (verified to exist). */
  evidence: z.array(FindingLocationSchema).default([]),
  /** The concrete rule to codify (for `convention`) or change to adopt (for `gap`). */
  suggestion: z.string().optional(),
  /** Free-form sub-tags (e.g. `folder-per-component`, `layering`, `monorepo`). */
  tags: z.array(z.string()).default([]),
  /** Model self-rated confidence 0..1, when provided. */
  confidence: z.number().optional(),
  /** Stable fingerprint (category + normalized title) carrying dismissed-history
   *  across re-runs and deduping across passes. */
  fingerprint: z.string(),
});
export type ConventionFinding = z.infer<typeof ConventionFindingSchema>;

/** The workspace/package-manager driving a monorepo, or `single` for a
 *  non-monorepo, or `unknown` when undetectable. */
export const WorkspaceToolSchema = z.enum([
  'pnpm',
  'bun',
  'yarn',
  'npm',
  'turbo',
  'nx',
  'cargo',
  'single',
  'unknown',
]);
export type WorkspaceTool = z.infer<typeof WorkspaceToolSchema>;

/** What a discovered workspace member is, by convention. */
export const RepoPackageRoleSchema = z.enum([
  'app',
  'package',
  'tool',
  'unknown',
]);
export type RepoPackageRole = z.infer<typeof RepoPackageRoleSchema>;

/** One workspace member (app/package/tool) the deterministic profiler discovered. */
export const RepoPackageSchema = z.object({
  /** Declared package name (or the directory name when unnamed). */
  name: z.string(),
  /** Repo-relative path to the member root. */
  path: z.string(),
  role: RepoPackageRoleSchema,
});
export type RepoPackage = z.infer<typeof RepoPackageSchema>;

/**
 * The deterministically-detected shape of the target repo. Produced by a cheap
 * filesystem pass (no model), NOT inferred by Claude — it grounds the synthesis
 * pass (what stack to generate a harness for) and the UI ProfileBanner. The
 * headline `isMonorepo` decides whether plugin/lint-meta artifacts are proposed
 * at all.
 */
export const RepoProfileSchema = z.object({
  isMonorepo: z.boolean(),
  workspaceTool: WorkspaceToolSchema,
  /** Discovered workspace members (empty for a single-package repo). */
  packages: z.array(RepoPackageSchema).default([]),
  /** Detected languages (e.g. `typescript`, `rust`). */
  languages: z.array(z.string()).default([]),
  /** Detected frameworks/libraries (e.g. `react`, `elysia`, `tauri`). */
  frameworks: z.array(z.string()).default([]),
  /** An `eslint.config.{js,mjs,ts}` flat config exists. */
  hasEslintFlatConfig: z.boolean().default(false),
  /** A `lint-meta` rule engine already exists in the repo. */
  hasLintMeta: z.boolean().default(false),
  /** A CLAUDE.md / AGENTS.md / AGENT_CONTRACT.md agent doc exists. */
  hasAgentDocs: z.boolean().default(false),
  /** Custom ESLint plugin package names already wired in the repo. */
  existingPlugins: z.array(z.string()).default([]),
});
export type RepoProfile = z.infer<typeof RepoProfileSchema>;

/**
 * The kind of harness artifact the synthesis pass proposes. Maps to a write
 * target: `lint-meta-rule` / `eslint-rule` / `eslint-plugin-file` / `eslint-config`
 * form the enforceable plugin + manifest; `agent-contract` is the CLAUDE.md /
 * AGENTS.md guardrail doc. `custom-lint-plugin` tags a multi-file bundle that
 * packages a whole project-specific ESLint plugin (its members are
 * `eslint-plugin-file` artifacts sharing one `group`) — a label for the group, so
 * the UI can announce "this is a generated lint plugin" without changing the
 * one-file-at-a-time write primitive.
 */
export const ArtifactKindSchema = z.enum([
  'lint-meta-rule',
  'eslint-rule',
  'eslint-plugin-file',
  'eslint-config',
  'agent-contract',
  'custom-lint-plugin',
]);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;

/** How `apply` writes the artifact. `create` writes a NEW file and FAILS if one
 *  already exists (never clobbers). `merge-section` inserts/replaces a delimited
 *  managed block (for CLAUDE.md / AGENTS.md), creating the file if absent. */
export const ArtifactWriteModeSchema = z.enum(['create', 'merge-section']);
export type ArtifactWriteMode = z.infer<typeof ArtifactWriteModeSchema>;

/**
 * One proposed harness artifact: a single file (or a managed block) the user can
 * preview and apply into the target repo. A multi-file output (e.g. an ESLint
 * plugin package) is several artifacts sharing a `group`, so the write primitive
 * stays one-file-at-a-time and the Rust containment check is uniform. The
 * lifecycle field (status/applied path) is owned by the Rust store, not here.
 */
export const ProposedArtifactSchema = z.object({
  /** Stable id assigned by the engine (apply/dismiss, dependsOn refs, UI keys). */
  id: z.string(),
  kind: ArtifactKindSchema,
  /** Groups artifacts that ship together (e.g. `eslint-plugin`); UI applies as a set. */
  group: z.string().optional(),
  /** Human label for the group, when grouped. */
  groupTitle: z.string().optional(),
  /** One-line headline. */
  title: z.string(),
  description: z.string(),
  /** Why this artifact, tied to the conventions it enforces. */
  rationale: z.string().optional(),
  /** Repo-relative destination path. The Rust core is the trust boundary and validates
   *  it on apply: containment (no `..` / absolute / symlink escape) AND rejection of
   *  auto-run execution sinks — `.claude/` & `.vscode/` config, `package.json` lifecycle
   *  scripts, `Makefile`, `.envrc`, git-hook / CI dirs — so a prompt-injected proposal
   *  can't land a one-click code-execution file. `merge-section` writes are further
   *  allowlisted to agent docs (CLAUDE.md / AGENTS.md / AGENT_CONTRACT.md). Kept a bare
   *  string here because the string alone is untrusted synthesis output; enforcement
   *  lives at the Rust write path, not in this schema. */
  targetPath: z.string(),
  writeMode: ArtifactWriteModeSchema,
  /** Full file content (for `create`) or the managed-section body (`merge-section`). */
  content: z.string(),
  /** Source language for syntax-highlighting the preview (e.g. `typescript`, `markdown`). */
  language: z.string().optional(),
  /** Fingerprints of the convention findings that motivated this artifact. */
  sourceFindings: z.array(z.string()).default([]),
  /** Ids of other artifacts this one depends on (e.g. a rule depends on the scaffold). */
  dependsOn: z.array(z.string()).default([]),
  /** Model self-rated confidence 0..1, when provided. */
  confidence: z.number().optional(),
  /** Stable fingerprint (kind + normalized targetPath) for dedup + dismissed-history. */
  fingerprint: z.string(),
});
export type ProposedArtifact = z.infer<typeof ProposedArtifactSchema>;
