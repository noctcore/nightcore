import { z } from 'zod';
import {
  EffortLevelSchema,
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

export type SurfaceCommandOf<T extends SurfaceCommand['type']> = Extract<
  SurfaceCommand,
  { type: T }
>;
