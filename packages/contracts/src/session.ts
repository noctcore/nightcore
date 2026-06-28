import { z } from 'zod';
import { PermissionModeSchema } from './config.js';

/** Session identity, status, and persisted-record shapes for a Nightcore session. */

/**
 * The session id space is owned by Nightcore's SessionManager (a monotonic
 * counter that never resets — see the supervisor pattern in
 * `@nightcore/engine`). This is distinct from the SDK's own session UUID, which
 * we record separately once the SDK's `init` message arrives.
 */
export const NightcoreSessionId = z.number().int().nonnegative().brand('NightcoreSessionId');
export type NightcoreSessionId = z.infer<typeof NightcoreSessionId>;

/** The lifecycle state of a Nightcore session. */
export const SessionStatusSchema = z.enum([
  'starting',
  'running',
  'awaiting-permission',
  'completed',
  'failed',
  'interrupted',
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * Nightcore-specific session metadata. The SDK owns the transcript (JSONL on
 * disk, resumable via `resume`); Nightcore stores only the bookkeeping it needs
 * to list/tag/relate sessions. Persisted by `@nightcore/storage`.
 */
export const SessionRecordSchema = z.object({
  /** Monotonic Nightcore id. */
  id: z.number().int().nonnegative(),
  /** SDK session UUID, populated once the SDK emits its `init` message. */
  sdkSessionId: z.string().optional(),
  /** The initial prompt that started the session. */
  prompt: z.string(),
  /** Model the session was started with. */
  model: z.string(),
  /** Permission mode at start. */
  permissionMode: PermissionModeSchema,
  /** Working directory the session ran in. */
  cwd: z.string(),
  status: SessionStatusSchema,
  /** Epoch ms. */
  createdAt: z.number().int(),
  /** Epoch ms; set on terminal status. */
  endedAt: z.number().int().optional(),
  /** Total cost in USD, from the SDK result message. */
  costUsd: z.number().optional(),
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;
