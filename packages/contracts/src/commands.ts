import { z } from 'zod';

import { EffortLevelSchema, McpServerEntrySchema, TaskKindSchema } from './config.js';
import { CouncilPresetIdSchema, CouncilRoutingEdgeSchema } from './council-preset.js';
import { ConventionCategorySchema, HarnessPolicySchema } from './harness.js';
import { AnalysisScopeSchema, FindingCategorySchema } from './insight.js';
import {
  ISSUE_BODY_MAX_LEN,
  ISSUE_COMMENTS_MAX,
  ISSUE_LABELS_MAX,
  ISSUE_LINKED_PRS_MAX,
  ISSUE_TITLE_MAX_LEN,
  IssueCommentSchema,
  IssueLinkedPrContextSchema,
} from './issue-triage.js';
import { ReviewLensSchema } from './pr-review.js';
import { AutonomyLevelSchema } from './provider.js';
import { ScorecardDimensionSchema } from './scorecard.js';
import { PermissionDecisionSchema, QuestionAnswerSchema } from './tools.js';

/**
 * `SurfaceCommand` — the typed stream flowing surface → engine.
 *
 * A surface (CLI/TUI/script) never calls engine methods ad hoc; it issues these
 * commands. This keeps the boundary symmetric with `NightcoreEvent` and makes
 * the engine drivable by anything that can emit a command (a hook, a test, a
 * future GUI).
 */

/**
 * The image formats a task attachment may carry. Bare format tokens (NOT MIME
 * strings) so the contract codegen emits clean Rust enum variants — the engine
 * maps `format` → the SDK base64 `media_type` (`image/<format>`) at the SDK
 * boundary. The set mirrors the Claude SDK's `Base64ImageSource.media_type`
 * (`image/jpeg|png|gif|webp`) and the web picker's accepted types.
 */
export const ImageFormatSchema = z.enum(['png', 'jpeg', 'webp', 'gif']);
export type ImageFormat = z.infer<typeof ImageFormatSchema>;

/**
 * One image attached to a task run, carried inline on `start-session`. `data` is
 * the raw base64 of the image bytes (NO `data:` URL prefix). The Rust core loads
 * these from the persisted app-data files at launch; the engine turns each into an
 * SDK image content block on the user message. Never logged (the bytes are user
 * content).
 */
export const WireImageSchema = z.object({
  format: ImageFormatSchema,
  data: z.string(),
});
export type WireImage = z.infer<typeof WireImageSchema>;

/**
 * Opt-in DEEP scan mode (issue #294). When present on a scan command the engine runs
 * each item (category / lens) as a MULTI-ROUND loop instead of a single pass: each
 * round is told the issues already found and asked for NEW distinct ones,
 * accumulating + de-duplicating until CONVERGENCE — `convergenceEmptyRounds` (K)
 * consecutive rounds that add ZERO net-new (post-dedup) findings — or the
 * `maxRoundsPerCategory` non-convergence backstop is hit. Absent ⇒ the classic
 * single-pass behavior (one pass + one corrective retry), byte-identical to pre-deep.
 *
 * This is NOT a cost cap: the user steers spend by watching the live running total
 * and cancelling. `maxRoundsPerCategory` exists ONLY to guarantee termination for a
 * model that emits one junk net-new finding per round forever — not to bound cost.
 * Modeled on the shared scan command surface (`BaseScanCommand.deep` on the engine
 * side) so the round loop reads it generically, though only `start-analysis` sets it.
 */
export const DeepScanConfigSchema = z.object({
  /** Non-convergence safety backstop: hard cap on rounds per item. NOT a cost cap. */
  maxRoundsPerCategory: z.number().int().positive().default(15),
  /** Convergence rule K: stop after this many consecutive rounds with zero net-new. */
  convergenceEmptyRounds: z.number().int().positive().default(2),
  /** Per-round findings cap (vs the single-pass 8); deep volume = rounds × this. */
  maxFindingsPerRound: z.number().int().positive().default(20),
});
export type DeepScanConfig = z.infer<typeof DeepScanConfigSchema>;

/** Start a new session. The engine assigns the monotonic id and echoes it back
 *  via a `session-started` event. */
export const StartSessionCommand = z.object({
  type: z.literal('start-session'),
  prompt: z.string(),
  /** Provider to run this session on. Absent ⇒ inherit the engine default. */
  providerId: z.string().optional(),
  /** Override the default model for this session. */
  model: z.string().optional(),
  /** Reasoning effort for this session. Effort has no live setter in the SDK, so
   *  it is fixed at session start (a surface's `/model` effort choice applies to
   *  the next session). */
  effort: EffortLevelSchema.optional(),
  /** Override the default autonomy ceiling for this session. The neutral
   *  provider-vocabulary (`bypass | auto-accept | ask | plan`); the Claude
   *  provider maps it to its own SDK permission mode at its boundary. Absent ⇒
   *  the kind preset's default, then the provider's configured default. */
  autonomy: AutonomyLevelSchema.optional(),
  /** Working directory; defaults to the process cwd. */
  cwd: z.string().optional(),
  /** The task kind driving this session. Resolves to an agent preset
   *  (system prompt + tool restrictions + default permission mode). Absent ⇒
   *  `build` (the default behavior). */
  kind: TaskKindSchema.optional(),
  /** Autonomy ceiling: max conversation turns for this session (SDK
   *  `Options.maxTurns`). Absent ⇒ inherit the `@nightcore/config` default. */
  maxTurns: z.number().int().positive().optional(),
  /** Autonomy ceiling: max spend in USD for this session (SDK
   *  `Options.maxBudgetUsd`). Absent ⇒ inherit the config default (uncapped
   *  unless configured). */
  maxBudgetUsd: z.number().positive().optional(),
  /** Resume a prior SDK session by its UUID (SDK `Options.resume`). Set on the
   *  recovery path when a persisted `sdkSessionId` exists so a crashed/HMR-killed
   *  run continues instead of restarting cold. Absent ⇒ a fresh session. Not a
   *  secret, but never logged at info/telemetry. */
  resumeSessionId: z.string().optional(),
  /** External MCP servers (already filtered to enabled entries by the Rust core)
   *  to inject for this session. The engine folds these into the SDK
   *  `Options.mcpServers` by `name`, additively over the user's native
   *  `.mcp.json`/`~/.claude.json`. Absent ⇒ none injected.
   *  May carry secrets in `env`/`headers`; never logged at info/telemetry. */
  mcpServers: z.array(McpServerEntrySchema).optional(),
  /** Pre-flight Context Pack: a curated, Nightcore-CONTROLLED
   *  context pack (the project Constitution from the Harness `CLAUDE.md`/`AGENTS.md`,
   *  an arch summary, the active convention rules, and `.nightcore/memory/*.md`)
   *  the Rust core assembles from on-disk sources and passes here. The engine folds
   *  it into the SDK `appendSystemPrompt` BEFORE the kind-preset persona (project
   *  rules lead, then the reviewer/build persona), truncated to a token budget so it
   *  can't crowd out the task. Injected via `appendSystemPrompt`, NOT `settingSources`,
   *  so it stays TRUSTED Nightcore content (unlike the repo's own auto-loaded
   *  `CLAUDE.md`). Absent ⇒ no pack injected. */
  appendContextPack: z.string().optional(),
  /** The project's harness runtime policy (protected paths + Bash deny patterns)
   *  read by the Rust core from `<project>/.nightcore/harness.json` (`policy` key).
   *  The engine enforces it in the PreToolUse gate for the whole session — the
   *  gate that holds even under `bypassPermissions`. Absent ⇒ no policy layer
   *  (no manifest, or the project disabled it). */
  harnessPolicy: HarnessPolicySchema.optional(),
  /** Session flight recorder (hardening module #5): absolute path of the per-task
   *  NDJSON tool-event ledger, computed by the Rust core as
   *  `<projectRoot>/.nightcore/ledger/<taskId>.ndjson` — the SAME project root
   *  `harnessPolicy` resolves from, NOT the worktree cwd. The engine appends one
   *  record per PreToolUse gate evaluation plus session start/end markers:
   *  append-only, parent dirs created lazily, FAIL-OPEN (a ledger write error
   *  never blocks a tool call), capped at ~5 MB with a final `truncated` marker.
   *  Absent ⇒ no recording (probes, or no project root). */
  ledgerPath: z.string().optional(),
  /** OPT-IN macOS OS-level WRITE containment (hardening module #15, tier "OS
   *  containment"): when true AND the host supports it (darwin with a working
   *  `sandbox-exec`), the engine wraps the resolved `claude` executable in a
   *  Seatbelt deny-write-except profile so file writes outside the session's
   *  writable roots (cwd, worktree git common dir, temp trees, Claude CLI state)
   *  are blocked at the OS layer — closing the lexical PreToolUse gate's
   *  documented gaps (Bash redirects, symlinks). Requested but unavailable ⇒ the
   *  engine logs a loud warning and runs UNwrapped (fail-open; the feature is
   *  experimental and default-off). Set by the Rust core from the
   *  `sandbox_sessions` setting. Absent ⇒ off (pre-feature shape). */
  sandboxWrites: z.boolean().optional(),
  /** Image attachments to include on the user message as SDK image content blocks.
   *  The Rust core loads these from the task's persisted app-data files at launch.
   *  Absent/empty ⇒ a text-only message.
   *  Carries user-content bytes — never logged at info/telemetry. */
  images: z.array(WireImageSchema).optional(),
  /** Council SEAT marker (issue #364): set ONLY by the engine's `CouncilRouter` when
   *  it spawns a debate seat session — never by the board. A seat is driven INSIDE the
   *  engine by the Conductor, so — unlike a board task — it pushes NO pending-launch
   *  slot in the Rust core's session↔task FIFO. The engine echoes this onto the seat's
   *  `session-started` event (see `SessionStartedEvent.council`) so the reader SKIPS
   *  board-FIFO correlation for it: no "correlation desync" warn, and — critically — no
   *  mis-bind that would pop a concurrently-pending board task's slot and poison its
   *  correlation. Absent ⇒ a normal board/scan session (the pre-feature shape). */
  council: z.boolean().optional(),
});

const sessionTarget = {
  sessionId: z.number().int().nonnegative(),
};

/** Stream additional user input into a running session. */
export const SendInputCommand = z.object({
  ...sessionTarget,
  type: z.literal('send-input'),
  text: z.string(),
});

/** Interrupt a running session (SDK `interrupt()`). */
export const InterruptCommand = z.object({
  ...sessionTarget,
  type: z.literal('interrupt'),
});

/** Change the model mid-session (SDK `setModel()`). */
export const SetModelCommand = z.object({
  ...sessionTarget,
  type: z.literal('set-model'),
  model: z.string(),
});

/** Change the autonomy ceiling mid-session. Carries the neutral provider
 *  vocabulary (`bypass | auto-accept | ask | plan`); the Claude provider bridges
 *  it to the SDK `setPermissionMode()` control request at its boundary. */
export const SetAutonomyCommand = z.object({
  ...sessionTarget,
  type: z.literal('set-autonomy'),
  autonomy: AutonomyLevelSchema,
});

/** Respond to a `permission-required` event. */
export const ApprovePermissionCommand = z.object({
  ...sessionTarget,
  type: z.literal('approve-permission'),
  requestId: z.string(),
  decision: PermissionDecisionSchema,
});

/** Respond to a `question-required` event (the SDK's `AskUserQuestion`). */
export const AnswerQuestionCommand = z.object({
  ...sessionTarget,
  type: z.literal('answer-question'),
  requestId: z.string(),
  answer: QuestionAnswerSchema,
});

/** Start an Insight analysis run. Unlike `start-session`, this is NOT a single
 *  Claude turn the surface renders — the engine fans out one read-only category
 *  pass per `categories` entry (bounded by `maxConcurrency`), grounds + dedups the
 *  findings, and streams `analysis-*` events keyed by `runId`. The Rust core
 *  assigns `runId` and owns persistence; the engine stays stateless about history.
 *  In `diff` scope the Rust core resolves `changedFiles` from git and the passes
 *  focus on them; in `repo` scope the model explores the whole tree itself. */
export const StartAnalysisCommand = z.object({
  type: z.literal('start-analysis'),
  /** Correlation id (also the persisted run id) assigned by the Rust core. */
  runId: z.string(),
  /** Absolute project root the passes run in (read-only). */
  projectPath: z.string(),
  /** Provider to run the analysis passes on. Absent ⇒ engine default (currently scans are Claude-only). */
  providerId: z.string().optional(),
  scope: AnalysisScopeSchema,
  /** Repo-relative files to focus on in `diff` scope (resolved by the Rust core).
   *  Ignored in `repo` scope. */
  changedFiles: z.array(z.string()).optional(),
  /** The categories to run (a subset of the 9). */
  categories: z.array(FindingCategorySchema),
  /** Model override for the passes; absent ⇒ inherit the resolved config. */
  model: z.string().optional(),
  /** Reasoning effort for the passes; absent ⇒ inherit. */
  effort: EffortLevelSchema.optional(),
  /** Max category passes to run at once. Absent ⇒ engine default (bounded). */
  maxConcurrency: z.number().int().positive().optional(),
  /** Per-category autonomy ceiling (SDK `Options.maxTurns`). */
  maxTurnsPerCategory: z.number().int().positive().optional(),
  /** Per-category spend ceiling in USD (SDK `Options.maxBudgetUsd`). */
  maxBudgetUsdPerCategory: z.number().positive().optional(),
  /** Opt-in DEEP mode (issue #294): run each category as a multi-round,
   *  exclusion-list convergence loop instead of a single pass. Absent ⇒ classic
   *  single-pass Insight (byte-identical to pre-deep). See {@link DeepScanConfigSchema}. */
  deep: DeepScanConfigSchema.optional(),
});

/** Cancel an in-flight Insight analysis run (aborts every category pass). */
export const CancelAnalysisCommand = z.object({
  type: z.literal('cancel-analysis'),
  runId: z.string(),
});

/** Start a Harness scan. Like `start-analysis` this is NOT a single rendered Claude
 *  turn — the engine first detects a deterministic repo profile, then fans out one
 *  read-only convention pass per `categories` entry (bounded by `maxConcurrency`),
 *  grounds + dedups the findings, runs a synthesis pass that proposes harness
 *  artifacts, and streams `harness-*` events keyed by `runId`. The Rust core assigns
 *  `runId`, owns persistence, and owns writing applied artifacts to disk; the engine
 *  stays stateless about history and never writes the target repo itself. The whole
 *  repo is always scanned (conventions are repo-wide), so there is no scope field. */
export const StartHarnessScanCommand = z.object({
  type: z.literal('start-harness-scan'),
  /** Correlation id (also the persisted run id) assigned by the Rust core. */
  runId: z.string(),
  /** Absolute project root the passes run in (read-only). */
  projectPath: z.string(),
  /** Provider to run the scan passes on. Absent ⇒ engine default (scans are Claude-only until Codex/other providers grow read-only structured runners). */
  providerId: z.string().optional(),
  /** The convention lenses to run (a subset of the 8). */
  categories: z.array(ConventionCategorySchema),
  /** Model override for the passes; absent ⇒ inherit the resolved config. */
  model: z.string().optional(),
  /** Reasoning effort for the passes; absent ⇒ inherit. */
  effort: EffortLevelSchema.optional(),
  /** Max convention passes to run at once. Absent ⇒ engine default (bounded). */
  maxConcurrency: z.number().int().positive().optional(),
  /** Per-pass autonomy ceiling (SDK `Options.maxTurns`). */
  maxTurnsPerCategory: z.number().int().positive().optional(),
  /** Per-pass spend ceiling in USD (SDK `Options.maxBudgetUsd`). */
  maxBudgetUsdPerCategory: z.number().positive().optional(),
  /** Opt-in DEEP mode (issue #294): run each convention lens as a multi-round,
   *  exclusion-list convergence loop instead of a single pass. Absent ⇒ classic
   *  single-pass Harness (byte-identical to pre-deep). See {@link DeepScanConfigSchema}. */
  deep: DeepScanConfigSchema.optional(),
});

/** Cancel an in-flight Harness scan (aborts every convention pass + synthesis). */
export const CancelHarnessScanCommand = z.object({
  type: z.literal('cancel-harness-scan'),
  runId: z.string(),
});

/** Start a Readiness Scorecard run. Like `start-analysis` this is NOT a single
 *  rendered Claude turn — the engine fans out one read-only GRADING pass per
 *  `dimensions` entry (bounded by `maxConcurrency`), each emitting a single A–F
 *  reading grounded in evidence, and streams `scorecard-*` events keyed by `runId`.
 *  The Rust core assigns `runId` and owns persistence; the engine stays stateless
 *  about history. The whole repo is always graded (readiness is repo-wide), so
 *  there is no scope field. */
export const StartScorecardCommand = z.object({
  type: z.literal('start-scorecard'),
  /** Correlation id (also the persisted run id) assigned by the Rust core. */
  runId: z.string(),
  /** Absolute project root the passes run in (read-only). */
  projectPath: z.string(),
  /** Provider to run the grading passes on. Absent ⇒ engine default (scans are Claude-only until other providers implement read-only structured output). */
  providerId: z.string().optional(),
  /** The dimensions to grade (a subset of the 10). */
  dimensions: z.array(ScorecardDimensionSchema),
  /** Model override for the passes; absent ⇒ inherit the resolved config. */
  model: z.string().optional(),
  /** Reasoning effort for the passes; absent ⇒ inherit. */
  effort: EffortLevelSchema.optional(),
  /** Max dimension passes to run at once. Absent ⇒ engine default (bounded). */
  maxConcurrency: z.number().int().positive().optional(),
  /** Per-dimension autonomy ceiling (SDK `Options.maxTurns`). */
  maxTurnsPerDimension: z.number().int().positive().optional(),
  /** Per-dimension spend ceiling in USD (SDK `Options.maxBudgetUsd`). */
  maxBudgetUsdPerDimension: z.number().positive().optional(),
});

/** Cancel an in-flight Scorecard run (aborts every dimension pass). */
export const CancelScorecardCommand = z.object({
  type: z.literal('cancel-scorecard'),
  runId: z.string(),
});

/** Start a PR Review run over a GitHub pull request of the active project. Like
 *  `start-analysis` this is NOT a single rendered Claude turn — the engine fans out
 *  one read-only review pass per `lenses` entry (bounded by `maxConcurrency`) over the
 *  PR DIFF, grounds each finding against `changedFiles`, dedups, and streams
 *  `pr-review-*` events keyed by `runId`. The Rust core resolves the diff (the sidecar
 *  is network-free): it runs `gh pr diff <n>` + `--name-only`, caps the diff, and
 *  passes both inline here. The review sessions run cwd = `projectPath` (the current
 *  checkout) for surrounding context, but the DIFF — never a checkout of the PR head —
 *  is the authoritative material reviewed. */
export const StartPrReviewCommand = z.object({
  type: z.literal('start-pr-review'),
  /** Correlation id (also the persisted run id) assigned by the Rust core. */
  runId: z.string(),
  /** Absolute project root the review sessions run in (read-only). */
  projectPath: z.string(),
  /** Provider to run the review passes on. Absent ⇒ engine default (scans are Claude-only). */
  providerId: z.string().optional(),
  /** The pull-request number to review (a positive integer). */
  prNumber: z.number().int().positive(),
  /** The `gh pr diff <n>` output, resolved + capped by the Rust core (the sidecar is
   *  network-free). */
  diff: z.string(),
  /** The PR's changed files (`gh pr diff <n> --name-only`), resolved by the Rust core.
   *  A finding whose `file` is not a member of this set is dropped (diff-relative
   *  grounding). */
  changedFiles: z.array(z.string()),
  /** The review lenses to run (a subset of the five). */
  lenses: z.array(ReviewLensSchema),
  /** Model override for the passes; absent ⇒ inherit the resolved config. */
  model: z.string().optional(),
  /** Reasoning effort for the passes; absent ⇒ inherit. */
  effort: EffortLevelSchema.optional(),
  /** Max lens passes to run at once. Absent ⇒ engine default (bounded). */
  maxConcurrency: z.number().int().positive().optional(),
  /** Opt-in DEEP mode (issue #294): run each review lens as a multi-round,
   *  exclusion-list convergence loop instead of a single pass. Absent ⇒ classic
   *  single-pass PR review. Because the review is DIFF-BOUNDED (findings are
   *  grounded against `changedFiles`), a deep run self-limits — it converges in a
   *  round or two rather than open-endedly. See {@link DeepScanConfigSchema}. */
  deep: DeepScanConfigSchema.optional(),
});

/** Cancel an in-flight PR Review run (aborts every lens pass). */
export const CancelPrReviewCommand = z.object({
  type: z.literal('cancel-pr-review'),
  runId: z.string(),
});

/** Start an Issue Triage validation. Unlike the `analysis`/`harness`/`scorecard`/
 *  `pr-review` scans this is a SINGLE read-only session (not a fan-out): the engine
 *  investigates one GitHub issue against the checkout and emits ONE structured
 *  verdict via `issue-validation-completed`. The Rust core assigns `runId`, owns
 *  persistence, and PRE-FETCHES all GitHub data (the sidecar is network-free) —
 *  issue title/body/author, capped comments, and the capped diffs of any linked PRs
 *  are injected inline here. Every GitHub-sourced field is attacker-controlled; the
 *  engine wraps them in `untrusted_block`. The session runs cwd = `projectPath`
 *  (read-only: Read/Glob/Grep/LS only, no Bash, no network). */
export const StartIssueValidationCommand = z.object({
  type: z.literal('start-issue-validation'),
  /** Correlation id (also the persisted run id) assigned by the Rust core. */
  runId: z.string(),
  /** Absolute project root the validation session runs in (read-only: Read/Glob/
   *  Grep/LS). NOT normalized/allowlisted by the contract — read confinement is
   *  enforced at RUNTIME by the engine's PreToolUse workspace-confinement gate (the
   *  same bypass-proof seam the scan siblings rely on), not here. */
  projectPath: z.string(),
  /** Provider to run the validation on. Absent ⇒ engine default (scans are Claude-only). */
  providerId: z.string().optional(),
  /** The issue number being validated (a positive integer). */
  issueNumber: z.number().int().positive(),
  /** The issue title (GitHub-sourced, untrusted; length-capped). */
  issueTitle: z.string().max(ISSUE_TITLE_MAX_LEN),
  /** The issue body markdown (GitHub-sourced, untrusted; length-capped so an
   *  oversized body can't flood the NDJSON protocol / session prompt). */
  issueBody: z.string().max(ISSUE_BODY_MAX_LEN),
  /** The issue author's GitHub login. Display-only (an attacker chooses their own
   *  login) — never a trust/privilege input. */
  issueAuthor: z.string(),
  /** The issue's labels (GitHub-sourced); help classify kind. Count-capped. */
  labels: z.array(z.string()).max(ISSUE_LABELS_MAX).default([]),
  /** The issue's comments, capped to the first page by the Rust core (untrusted).
   *  Count-capped here too so the boundary bounds the aggregate independently. */
  comments: z.array(IssueCommentSchema).max(ISSUE_COMMENTS_MAX).default([]),
  /** Linked PRs plus their capped diffs, pre-fetched by the Rust `gh` seam and
   *  injected as untrusted context (the session never shells out). Count-capped. */
  linkedPrs: z.array(IssueLinkedPrContextSchema).max(ISSUE_LINKED_PRS_MAX).default([]),
  /** Model override for the session; absent ⇒ inherit the resolved config. */
  model: z.string().optional(),
  /** Reasoning effort for the session; absent ⇒ inherit. */
  effort: EffortLevelSchema.optional(),
  /** Autonomy ceiling: max conversation turns (SDK `Options.maxTurns`). */
  maxTurns: z.number().int().positive().optional(),
  /** Autonomy ceiling: max spend in USD (SDK `Options.maxBudgetUsd`). */
  maxBudgetUsd: z.number().positive().optional(),
});

/** Cancel an in-flight Issue Triage validation (aborts the session). */
export const CancelIssueValidationCommand = z.object({
  type: z.literal('cancel-issue-validation'),
  runId: z.string(),
});

/**
 * Start a governed Council debate run (issue #350). Like the scan `start-*` families
 * this is NOT a single session — the engine's Conductor drives the
 * `Frame → Propose(blind) → Debate(≤2) → Converge(human)` state machine over N seats,
 * keyed by `runId`. The Rust core assigns `runId`; the engine owns the run + its
 * append-only transcript. The seats, stages, routing, and hard budget/round caps all
 * come from the preset `presetId` resolves to (validated at Frame). The Conductor is
 * the sole bus writer — seats have zero agent-to-agent authority (safety #1).
 */
export const StartCouncilCommand = z.object({
  type: z.literal('start-council'),
  /** The council run id the engine keys the transcript by (Rust-assigned). */
  runId: z.string(),
  /** The preset to seed the run from — resolved + validated by the engine. */
  presetId: CouncilPresetIdSchema,
  /** The task the council debates. */
  objective: z.string(),
  /** The working directory seat sessions run in (the active project root). Absent ⇒
   *  the engine process cwd. */
  projectPath: z.string().optional(),
});

/** Kill a running Council debate run immediately (safety non-negotiable #4 — the kill
 *  switch; never "run until they agree"). Halts turn-taking at the next checkpoint and
 *  aborts the in-flight seat turn. A no-op for an unknown/finished run. */
export const KillCouncilCommand = z.object({
  type: z.literal('kill-council'),
  runId: z.string(),
});

/**
 * The human judge's terminal Converge verdict (issue #353). P1's Converge stage is
 * HUMAN-only — no agent-judge, no vote — so this is the sole way a run's parked seat
 * positions are resolved (safety non-negotiable #7: the human is the terminal
 * authority). Three verdicts:
 *  - `accept` — adopt ONE seat's position as the run outcome (`seatId` names it).
 *  - `reject` — reject every position; the run closes with no adopted outcome.
 *  - `judge`  — the human writes their OWN ruling (`note` carries it).
 */
export const CouncilConvergeDecisionSchema = z.enum(['accept', 'reject', 'judge']);
export type CouncilConvergeDecision = z.infer<typeof CouncilConvergeDecisionSchema>;

/**
 * Resolve a council run's PARKED Converge decision with the human judge's verdict
 * (issue #353) — the human gavel that closes the run (safety non-negotiable #7). The
 * verdict flows through the engine's Conductor — the sole bus writer — which records
 * it onto the append-only transcript and closes the Converge stage. It is NEVER a
 * direct transcript-store write from the surface (that would bypass the mediated write
 * path, safety #1). `seatId` is REQUIRED for `accept` (the seat whose position is
 * adopted) and ignored otherwise; `note` is REQUIRED for `judge` (the ruling) and
 * optional context for `accept`/`reject`. A no-op for a run with no parked decision
 * (unknown / already resolved).
 */
export const ResolveCouncilConvergeCommand = z.object({
  type: z.literal('resolve-council-converge'),
  /** The council run whose parked Converge decision is being resolved. */
  runId: z.string(),
  /** The human judge's verdict. */
  decision: CouncilConvergeDecisionSchema,
  /** The seat whose position is adopted — REQUIRED for `accept`, ignored otherwise. */
  seatId: z.string().optional(),
  /** The human's ruling (REQUIRED for `judge`) or a short reason for `accept`/`reject`. */
  note: z.string().optional(),
});

/**
 * Rewire a LIVE Council run's routing policy — the editable canvas edges (issue #371).
 * A routing edge is "A informs B": which seats' outputs reach a recipient seat as its
 * MEDIATED, quoted, injection-scanned peer context in the Debate stage. `edges` REPLACES
 * the run's current edge set (an empty list restores the open default — every seat
 * informs every other).
 *
 * This is a CONDUCTOR DIRECTIVE, never a direct seat write (safety non-negotiable #1 —
 * the injection firewall). The engine's Conductor — the sole bus writer — applies the
 * new policy to the next Debate round and records the change onto the append-only
 * transcript (safety #7). An edge only FILTERS which already-mediated peer content a seat
 * receives; it can never introduce an un-mediated agent-to-agent path. Edges naming a
 * seat the run does not define are dropped. A no-op for an unknown/finished run.
 */
export const SetCouncilRoutingCommand = z.object({
  type: z.literal('set-council-routing'),
  /** The live council run whose routing policy is being rewired. */
  runId: z.string(),
  /** The new "A informs B" edge set — REPLACES the run's current edges. Empty ⇒ the open
   *  default (every seat informs every other). */
  edges: z.array(CouncilRoutingEdgeSchema),
});

/** The discriminated union of every surface → engine command, keyed by `type`. */
export const SurfaceCommandSchema = z.discriminatedUnion('type', [
  StartSessionCommand,
  SendInputCommand,
  InterruptCommand,
  SetModelCommand,
  SetAutonomyCommand,
  ApprovePermissionCommand,
  AnswerQuestionCommand,
  StartAnalysisCommand,
  CancelAnalysisCommand,
  StartHarnessScanCommand,
  CancelHarnessScanCommand,
  StartScorecardCommand,
  CancelScorecardCommand,
  StartPrReviewCommand,
  CancelPrReviewCommand,
  StartIssueValidationCommand,
  CancelIssueValidationCommand,
  StartCouncilCommand,
  KillCouncilCommand,
  ResolveCouncilConvergeCommand,
  SetCouncilRoutingCommand,
]);
export type SurfaceCommand = z.infer<typeof SurfaceCommandSchema>;

/**
 * `SurfaceQuery` — the REQUEST/REPLY stream flowing surface → engine, parallel to
 * the fire-and-forget `SurfaceCommand`. A query carries a `requestId` the engine
 * echoes back on the matching `query-result` event, so the caller (the Rust core)
 * can `await` a correlated reply over the otherwise one-way NDJSON protocol.
 *
 * These back the SDK session store (read-only history + the two mutations). They
 * are pure disk reads/writes via the SDK — no session runner is involved.
 *
 * `dir` semantics mirror the SDK: OMIT it to search ALL project dirs by UUID (the
 * prune-safe path that finds a session even after its worktree is gone); PASS a
 * project root to discover sibling sessions that still have a live worktree.
 */

/** A correlation id every query carries; the matching `query-result` echoes it. */
const requestTarget = {
  requestId: z.string(),
};

/** List the SDK sessions for a project dir (omit `dir` ⇒ all project dirs). */
export const ListSessionsQuery = z.object({
  ...requestTarget,
  type: z.literal('list-sessions'),
  dir: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  includeWorktrees: z.boolean().optional(),
});

/** Read one session's metadata by its SDK session UUID. */
export const GetSessionInfoQuery = z.object({
  ...requestTarget,
  type: z.literal('get-session-info'),
  sdkSessionId: z.string(),
  dir: z.string().optional(),
});

/** Read one session's transcript messages by its SDK session UUID. */
export const GetSessionMessagesQuery = z.object({
  ...requestTarget,
  type: z.literal('get-session-messages'),
  sdkSessionId: z.string(),
  dir: z.string().optional(),
  limit: z.number().int().positive().optional(),
  offset: z.number().int().nonnegative().optional(),
  includeSystemMessages: z.boolean().optional(),
});

/** Rename a session (sets its custom title). */
export const RenameSessionQuery = z.object({
  ...requestTarget,
  type: z.literal('rename-session'),
  sdkSessionId: z.string(),
  title: z.string(),
  dir: z.string().optional(),
});

/** Tag a session, or clear its tag when `tag` is `null`. */
export const TagSessionQuery = z.object({
  ...requestTarget,
  type: z.literal('tag-session'),
  sdkSessionId: z.string(),
  tag: z.string().nullable(),
  dir: z.string().optional(),
});

/** Read a provider's resolved configuration for a project (the read-only
 *  inspector). Unlike the session-store queries, this DOES spin a transient SDK
 *  probe (no model turn) to read scope-aware config via the SDK control methods.
 *  `providerId` selects the provider to inspect; omit ⇒ the engine default.
 *  `dir` is the project root the resolution keys off; omit ⇒ the engine's cwd. */
export const GetProviderConfigQuery = z.object({
  ...requestTarget,
  type: z.literal('get-provider-config'),
  providerId: z.string().optional(),
  dir: z.string().optional(),
});

/** Read a provider's static {@link ProviderCapabilities} descriptor — the
 *  capability matrix the UI/orchestration degrade from (issue #18). Unlike
 *  `get-provider-config` this is provider-static (no project dir, no probe): the
 *  engine answers straight from the selected provider's `capabilities()`, so the
 *  Rust core single-sources the truthful descriptor from the engine instead of
 *  duplicating it. `providerId` omitted ⇒ the engine default. */
export const GetCapabilitiesQuery = z.object({
  ...requestTarget,
  type: z.literal('get-capabilities'),
  providerId: z.string().optional(),
});

/** Read the registered providers' DYNAMIC model catalog — the engine's `listModels()`
 *  output (each {@link ModelDescriptorSchema}: the id passed to `setModel()`, a
 *  display name, and the per-model effort levels) a surface renders its `/model`
 *  picker from (issue #80). The engine returns a merged provider catalog, fetched
 *  from each provider at runtime where available, so Claude and Codex can be chosen
 *  per task in the same sidecar process. */
export const GetModelsQuery = z.object({
  ...requestTarget,
  type: z.literal('get-models'),
});

/** Validate an armed lint-plugin rule via ESLint's `RuleTester` on demand (issue
 *  #185) — the "is this armed check a real rule that actually fires, not a placebo?"
 *  probe. The engine loads the rule cross-toolchain (TS/ESM/CJS) and runs the
 *  supplied cases (or a minimal structural probe when none are given) against the
 *  TARGET project's own ESLint, returning a structured {@link RuleValidationResult}
 *  on the reply's `ruleValidation` slot. Fails SOFT: a load/setup failure is reported
 *  as `outcome: 'error'`, never a thrown crash. */
export const ValidateRuleQuery = z.object({
  ...requestTarget,
  type: z.literal('validate-rule'),
  /** The rule id being validated (for reporting; e.g. `@nightcore/no-state-in-body`). */
  ruleId: z.string(),
  /** Absolute or `projectPath`-relative path to the module exporting the rule — a
   *  single-rule module OR a plugin exposing a `.rules` map. Loaded cross-toolchain. */
  rulePath: z.string(),
  /** The rule's key within a plugin's `rules` map. Omit ⇒ derived from `ruleId`'s
   *  last path segment (a plugin entry) or ignored (a single-rule module). */
  ruleName: z.string().optional(),
  /** Project root used to resolve a relative `rulePath` and the ESLint/RuleTester
   *  toolchain, so validation runs against the target's own ESLint version. Omit ⇒
   *  the engine cwd. */
  projectPath: z.string().optional(),
  /** RuleTester `valid` cases. Each entry is source code, or a JSON string of a
   *  RuleTester case object (`{ code, options, ... }`); a non-JSON string is the code. */
  validCases: z.array(z.string()).default([]),
  /** RuleTester `invalid` cases, each a JSON string of `{ code, errors, output? }`.
   *  A non-JSON string is taken as `code` expecting at least one reported error. */
  invalidCases: z.array(z.string()).default([]),
});

/** The discriminated union of every request/reply surface → engine query, keyed by `type`. */
export const SurfaceQuerySchema = z.discriminatedUnion('type', [
  ListSessionsQuery,
  GetSessionInfoQuery,
  GetSessionMessagesQuery,
  RenameSessionQuery,
  TagSessionQuery,
  GetProviderConfigQuery,
  GetCapabilitiesQuery,
  GetModelsQuery,
  ValidateRuleQuery,
]);
export type SurfaceQuery = z.infer<typeof SurfaceQuerySchema>;
