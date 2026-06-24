import { z } from 'zod';
import {
  EffortLevelSchema,
  McpServerEntrySchema,
  PermissionModeSchema,
  TaskKindSchema,
} from './config.js';
import { PermissionDecisionSchema } from './tools.js';

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

export const SurfaceCommandSchema = z.discriminatedUnion('type', [
  StartSessionCommand,
  SendInputCommand,
  InterruptCommand,
  SetModelCommand,
  SetPermissionModeCommand,
  ApprovePermissionCommand,
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
