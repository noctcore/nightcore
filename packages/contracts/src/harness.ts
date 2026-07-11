import { z } from 'zod';

import { runTotals, scanFailure, TokenUsageSchema } from './event-fragments.js';
import { RuleCoverageGapSchema } from './harness-enforce.js';
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
  // A standalone tool config file (`.gitleaks.toml`, `.dependency-cruiser.cjs`,
  // `.npmrc`, an env schema, lefthook/commitlint configs, …) — the create-mode
  // carrier for the hardening-catalog producer modules (#4/#7/#11/#13/#18).
  'tool-config',
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

/**
 * How a harness proposal reaches the repo. `apply-artifacts` bundles one or more
 * {@link ProposedArtifact}s written straight to disk through the hardened `apply.rs`
 * path (docs, lint configs at NEW paths, a plugin bundle). `agent-task` is a change
 * that must NOT be a blind file write — wiring a plugin into `eslint.config.*`,
 * pre-commit hooks, `package.json` scripts — so it converts to a worktree Build task
 * an agent performs and a human reviews as a diff. The split is the security hinge:
 * execution-adjacent work reaches sink-class targets WITHOUT weakening the apply-path
 * denylist, because the human gate moves from "confirm a file write" to "review a
 * worktree diff".
 */
export const HarnessProposalKindSchema = z.enum(['apply-artifacts', 'agent-task']);
export type HarnessProposalKind = z.infer<typeof HarnessProposalKindSchema>;

/**
 * A Structure-Lock gauntlet check a proposal SUGGESTS arming once its work lands (an
 * `apply-artifacts` plugin is applied, an `agent-task` diff is merged). This is a
 * SUGGESTION shown to the user, never an authority: arming still goes through the
 * human-gated `arm_harness_gauntlet_check` command (which writes `.nightcore/harness.json`
 * itself), so a prompt-injected proposal can't silently install a gate. `kind` is a bare
 * wire string (not an enum) so a future gauntlet kind never breaks deserialize; it is
 * validated against the armable-kind allowlist at arm time in Rust.
 */
export const HarnessCheckSchema = z.object({
  /** The check's `name` in the manifest (stable identity for merge-by-name). */
  name: z.string(),
  /** `lint-plugin` | `dependency-cruiser` | `coverage-threshold` (validated at arm time). */
  kind: z.string(),
  /** The shell command the gauntlet runs (e.g. `npx eslint .`). */
  command: z.string(),
  /** For a Drift-v1 COMPILED check (T15): the `conventionFingerprint` of the
   *  convention this check verifies — the join key an EnforceRun uses to attribute
   *  the check's site counts back to a `ConventionDrift` record. Absent on a plain
   *  hardening arm-suggestion. Grounded by the engine against a real convention
   *  finding (a fingerprint that matches no convention is dropped), never trusted
   *  from raw model output. */
  conventionFingerprint: z.string().optional(),
});
export type HarnessCheck = z.infer<typeof HarnessCheckSchema>;

/**
 * One task-shaped harness proposal — the unit the user CONVERTS into a board task
 * (mirroring Insight's finding→task path), distinct from the file-level
 * {@link ProposedArtifact}. Synthesis emits proposals alongside artifacts: each
 * proposal is either an `apply-artifacts` bundle (referencing `artifactIds`) or an
 * `agent-task` (carrying a `prompt` + optional `verifyCommand` gauntlet gate). The
 * lifecycle (status/linked task) is owned by the Rust store, not here.
 */
/**
 * The runtime enforcement policy a project's `.nightcore/harness.json` declares
 * under its `policy` key, carried on `start-session` so the engine's PreToolUse
 * gate (hardening module #3: protected paths + bypass-flag denial) can enforce it
 * for the whole run — including under `bypassPermissions`, where `canUseTool` is
 * never consulted. The Rust core READS the manifest (it owns the file; the engine
 * never touches the target repo) and passes the RESOLVED effective policy here:
 * a disabled policy (`policy.enabled: false`) or an absent manifest is simply not
 * sent. Patterns are project-authored config, never model output.
 */
export const HarnessPolicySchema = z.object({
  /** Repo-relative paths/globs the native mutation tools (Write/Edit/…) may not
   *  touch (lockfiles, migrations, generated code, …). `*` matches within a path
   *  segment, `**` across segments; a pattern without `/` matches its basename at
   *  any depth; a non-glob pattern also protects its whole subtree. */
  protectedPaths: z.array(z.string()).default([]),
  /** Regex patterns (JS syntax, case-sensitive) matched against the RAW Bash
   *  command line; a match denies the call (e.g. `--no-verify`, `git commit
   *  \\s+--amend`). An invalid pattern is warn-and-skipped by the engine. */
  denyBashPatterns: z.array(z.string()).default([]),
  /** Repo-relative paths/globs the native READ tools (Read/Grep/Glob) may not
   *  target — secret hygiene (`.env*`, key material; module #4) and
   *  prompt-injection quarantine (flagged paths; module #12). Same glob
   *  semantics as `protectedPaths`. Bash-level reads (`cat .env`) are the
   *  project's `denyBashPatterns` to declare — one owner per channel. */
  denyReadPaths: z.array(z.string()).default([]),
  /** Tool names denied outright for sessions in this project (module #9,
   *  least-privilege): matched case-sensitively against the SDK tool name
   *  (e.g. `WebSearch`, or `mcp__<server>__<tool>`). The engine denies the
   *  call at PreToolUse, so it holds under `bypassPermissions` too. */
  disallowedTools: z.array(z.string()).default([]),
  /** VERBATIM SDK permission-rule strings auto-APPROVED for sessions in this
   *  project (module #9, allow tier): exact tool names (`WebSearch`) or rules
   *  (`Bash(git status:*)`). Unioned into SDK `Options.allowedTools`, which is
   *  additive auto-approval only (the exclusive whitelist is the separate
   *  `tools` option), so entries here can never RESTRICT a session — and an
   *  allow never overrides a deny: SDK deny rules and the engine's PreToolUse
   *  gate still win. */
  allowTools: z.array(z.string()).default([]),
  /** Exact SDK tool names (same convention as `disallowedTools`) that must
   *  escalate to an INTERACTIVE permission ask even in permissive modes
   *  (module #9, ask tier). The engine's PreToolUse gate returns
   *  `permissionDecision: 'ask'`, which the CLI forwards to the host's
   *  `canUseTool` — even under `bypassPermissions`. Every deny tier wins over
   *  ask (a tool both denied and asked-for is denied). */
  askTools: z.array(z.string()).default([]),
  /** Repo-relative paths/globs (same glob semantics as `protectedPaths`) that
   *  DOWNGRADE the engine's built-in execution-sink ASK gate to a silent allow
   *  for this project. The exec-sink gate escalates any write to a path that
   *  changes how code executes — CI workflows (`.github/workflows`), git/husky
   *  hooks, Claude config (`.claude/**`), or package scripts (`package.json`) —
   *  to an interactive approval, even under `bypassPermissions`. A repo where
   *  agents legitimately manage CI can name those sinks here (e.g.
   *  `.github/workflows/**`) so their writes proceed without a prompt. This ONLY
   *  softens the exec-sink ASK; it can never override a deny (destructive deny,
   *  workspace confinement, or a `protectedPaths` entry all still win), so an
   *  allowance can't be used to punch a hole in a hard rail. */
  allowExecSinks: z.array(z.string()).default([]),
});
export type HarnessPolicy = z.infer<typeof HarnessPolicySchema>;

export const HarnessProposalSchema = z.object({
  /** Stable id assigned by the engine (convert/dismiss, UI keys). */
  id: z.string(),
  kind: HarnessProposalKindSchema,
  /** One-line headline (becomes the converted task's title). */
  title: z.string(),
  /** What the proposal does, concretely (becomes the task body). */
  description: z.string(),
  /** Why it matters / what an agent breaks without it. */
  rationale: z.string().optional(),
  /** `apply-artifacts`: the artifact ids this proposal applies together as a bundle. */
  artifactIds: z.array(z.string()).default([]),
  /** `agent-task`: the Build-task prompt describing the change to make in a worktree. */
  prompt: z.string().optional(),
  /** `agent-task`: the machine-checkable done-command → the converted task's
   *  `verify_command` (runs as a Structure-Lock check before the paid reviewer). */
  verifyCommand: z.string().optional(),
  /** The gauntlet check to SUGGEST arming once this proposal's work lands (human-gated). */
  harnessCheck: HarnessCheckSchema.optional(),
  /** Model self-rated confidence 0..1, when provided. */
  confidence: z.number().optional(),
  /** Stable fingerprint (kind + normalized target signature) for dedup + convert/dismiss
   *  carry-forward across re-scans. */
  fingerprint: z.string(),
});
export type HarnessProposal = z.infer<typeof HarnessProposalSchema>;

/**
 * Harness (codebase convention auditor) events. Like the `analysis-*` family these
 * carry no `sessionId` and correlate by `runId`; the Rust reader routes the whole
 * `harness-*` family to the `nc:harness` channel and persists the run on
 * `harness-scan-completed`. The flow adds two hops over Insight: a `harness-profile-ready`
 * up front (the deterministic repo profile) and a `harness-proposals-ready` near the
 * end (the synthesized artifacts), so the UI can render the profile banner and the
 * proposed-harness panel before the terminal event lands.
 */

/** A scan started. Echoes the resolved categories/model for the UI header. */
export const HarnessScanStartedEvent = z.object({
  type: z.literal('harness-scan-started'),
  runId: z.string(),
  categories: z.array(ConventionCategorySchema),
  model: z.string(),
});

/** The deterministic repo profile is ready (emitted before any convention pass). */
export const HarnessProfileReadyEvent = z.object({
  type: z.literal('harness-profile-ready'),
  runId: z.string(),
  profile: RepoProfileSchema,
});

/** A convention pass began exploring (the UI shows skeleton cards for it). */
export const HarnessCategoryStartedEvent = z.object({
  type: z.literal('harness-category-started'),
  runId: z.string(),
  category: ConventionCategorySchema,
});

/** A convention pass finished: its grounded findings stream in as a batch, plus the
 *  pass's own token usage and cost so the UI can show per-lens spend. */
export const HarnessCategoryCompletedEvent = z.object({
  type: z.literal('harness-category-completed'),
  runId: z.string(),
  category: ConventionCategorySchema,
  findings: z.array(ConventionFindingSchema),
  usage: TokenUsageSchema.optional(),
  costUsd: z.number().default(0),
  /** Set when the pass itself failed (parse/abort): findings is then empty and the
   *  UI marks the lens errored rather than "0 findings". */
  error: z.string().optional(),
});

/** The synthesis pass began (after every convention pass, before proposals).
 *  Carries no payload beyond `runId`: it exists so the UI can show a
 *  "Synthesizing harness…" state instead of a frozen, all-lenses-done dead zone,
 *  and so the Rust/terminal logs mark the start of the (serial) synthesis tail. */
export const HarnessSynthesisStartedEvent = z.object({
  type: z.literal('harness-synthesis-started'),
  runId: z.string(),
});

/** The synthesis pass finished: the proposed harness artifacts stream in as a batch.
 *  Emitted after every convention pass, before the terminal event. `proposals` are the
 *  task-shaped recommendations the user converts to board tasks; additive (`.default([])`)
 *  so a scan that emits only artifacts — and any pre-proposals on-disk run — stays valid. */
export const HarnessProposalsReadyEvent = z.object({
  type: z.literal('harness-proposals-ready'),
  runId: z.string(),
  artifacts: z.array(ProposedArtifactSchema),
  proposals: z.array(HarnessProposalSchema).default([]),
});

/** The whole scan finished: the final profile, deduped convention findings, and
 *  proposed artifacts plus run totals. The Rust reader persists from THIS event. */
export const HarnessScanCompletedEvent = z.object({
  type: z.literal('harness-scan-completed'),
  runId: z.string(),
  profile: RepoProfileSchema,
  findings: z.array(ConventionFindingSchema),
  artifacts: z.array(ProposedArtifactSchema),
  /** The task-shaped proposals the user converts to board tasks. Additive
   *  (`.default([])`) so an older on-disk run loads with an empty set — zero risk. */
  proposals: z.array(HarnessProposalSchema).default([]),
  /** ENFORCE-lite rule coverage: one {@link RuleCoverageGapSchema} per convention —
   *  `enforced` / `documented-only` / `unenforced`. Additive (`.default([])`) so an
   *  older, pre-coverage on-disk run loads with an empty set (mirrors `proposals`
   *  above). Coverage, not conformance — it never claims a convention is FOLLOWED. */
  coverage: z.array(RuleCoverageGapSchema).default([]),
  categoriesRun: z.array(ConventionCategorySchema),
  ...runTotals,
  /** Set when the synthesis pass could not produce proposals (parse/session failure):
   *  the scan still completes with its findings, and the UI marks synthesis errored
   *  rather than silently showing zero proposals. */
  synthesisError: z.string().optional(),
});

/** The scan failed before completing (could not start, or aborted). Reuses the
 *  same reason set as `analysis-failed` (collapses to one generated Rust enum). */
export const HarnessScanFailedEvent = z.object({
  type: z.literal('harness-scan-failed'),
  runId: z.string(),
  ...scanFailure,
});
