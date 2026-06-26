import { z } from 'zod';
import {
  EffortLevelSchema,
  McpServerEntrySchema,
  PermissionModeSchema,
  TaskKindSchema,
} from './config.js';
import { PermissionDecisionSchema, QuestionAnswerSchema } from './tools.js';
import { AnalysisScopeSchema, FindingCategorySchema } from './insight.js';
import { ConventionCategorySchema } from './harness.js';

/**
 * `SurfaceCommand` — the typed stream flowing surface → engine.
 *
 * A surface (CLI/TUI/script) never calls engine methods ad hoc; it issues these
 * commands. This keeps the boundary symmetric with `NightcoreEvent` and makes
 * the engine drivable by anything that can emit a command (a hook, a test, a
 * future GUI).
 */

/** Start a new session. The engine assigns the monotonic id and echoes it back
 *  via a `session-started` event. */
export const StartSessionCommand = z.object({
  type: z.literal('start-session'),
  prompt: z.string(),
  /** Override the default model for this session. */
  model: z.string().optional(),
  /** Reasoning effort for this session. Effort has no live setter in the SDK, so
   *  it is fixed at session start (a surface's `/model` effort choice applies to
   *  the next session). */
  effort: EffortLevelSchema.optional(),
  /** Override the default permission mode for this session. */
  permissionMode: PermissionModeSchema.optional(),
  /** Working directory; defaults to the process cwd. */
  cwd: z.string().optional(),
  /** The task kind driving this session (M4). Resolves to an agent preset
   *  (system prompt + tool restrictions + default permission mode). Absent ⇒
   *  `build` ⇒ identical to pre-M4 behavior. */
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
   *  `.mcp.json`/`~/.claude.json`. Absent ⇒ none injected (the pre-feature shape).
   *  May carry secrets in `env`/`headers`; never logged at info/telemetry. */
  mcpServers: z.array(McpServerEntrySchema).optional(),
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

/** Change the permission mode mid-session (SDK `setPermissionMode()`). */
export const SetPermissionModeCommand = z.object({
  ...sessionTarget,
  type: z.literal('set-permission-mode'),
  mode: PermissionModeSchema,
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
});

/** Cancel an in-flight Harness scan (aborts every convention pass + synthesis). */
export const CancelHarnessScanCommand = z.object({
  type: z.literal('cancel-harness-scan'),
  runId: z.string(),
});

export const SurfaceCommandSchema = z.discriminatedUnion('type', [
  StartSessionCommand,
  SendInputCommand,
  InterruptCommand,
  SetModelCommand,
  SetPermissionModeCommand,
  ApprovePermissionCommand,
  AnswerQuestionCommand,
  StartAnalysisCommand,
  CancelAnalysisCommand,
  StartHarnessScanCommand,
  CancelHarnessScanCommand,
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

/** Read the active provider's resolved configuration for a project (the read-only
 *  inspector). Unlike the session-store queries, this DOES spin a transient SDK
 *  probe (no model turn) to read scope-aware config via the SDK control methods.
 *  `dir` is the project root the resolution keys off; omit ⇒ the engine's cwd. */
export const GetProviderConfigQuery = z.object({
  ...requestTarget,
  type: z.literal('get-provider-config'),
  dir: z.string().optional(),
});

export const SurfaceQuerySchema = z.discriminatedUnion('type', [
  ListSessionsQuery,
  GetSessionInfoQuery,
  GetSessionMessagesQuery,
  RenameSessionQuery,
  TagSessionQuery,
  GetProviderConfigQuery,
]);
export type SurfaceQuery = z.infer<typeof SurfaceQuerySchema>;
