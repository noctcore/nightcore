import { z } from 'zod';

/** Tool-risk classification and permission/question reply shapes. */

/**
 * The native tool names that MUTATE the workspace — the set a read-only agent must
 * be denied. Canonical for the TS tiers: the engine's Claude presets deny exactly
 * this list (`providers/claude/kind-presets.ts` re-exports it as `WRITE_TOOLS`),
 * and `diagnoseSkillDescriptor` (`skill.ts`) checks a skill that declares
 * `writesCode: false` against it, so "read-only" means the same thing to the
 * enforcement path and to the descriptor that claims it.
 *
 * Homed here rather than in the engine because a claim about which tools write is
 * shared vocabulary (the same reasoning that puts `NATIVE_SDK_TOOLS` and the policy
 * matchers in this package): a surface can never import `@nightcore/engine`, so a
 * second copy would be free to disagree with enforcement. ENFORCEMENT still lives
 * in the engine — this is the name list, not the gate.
 */
export const WRITE_TOOL_NAMES: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'ApplyPatch',
] as const;

/**
 * How risky a tool is, which drives how tightly the PermissionLayer gates it:
 *  - `safe`      — read-only; may be auto-allowed.
 *  - `mutating`  — writes/edits state; gated by mode + allow/deny.
 *  - `dangerous` — arbitrary effect (shell exec, network); ALWAYS requires
 *                  interactive approval unless explicitly allow-listed, even
 *                  under an auto-accepting mode.
 */
export const ToolRiskSchema = z.enum(['safe', 'mutating', 'dangerous']);
export type ToolRisk = z.infer<typeof ToolRiskSchema>;

/**
 * A decision the PermissionLayer renders for a single tool-use request.
 * Mirrors the SDK's `PermissionResult` shape but in contract terms so surfaces
 * can construct approvals without importing the SDK.
 */
export const PermissionDecisionSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    /** Optionally rewrite the tool input before execution. */
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    /** Message returned to the model explaining the denial. */
    message: z.string(),
  }),
]);
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/**
 * A surface's reply to a `question-required` event (the SDK's `AskUserQuestion`).
 * Parallel to `PermissionDecisionSchema` but for a Q&A dialog rather than a
 * tool allow/deny:
 *  - `answer` — the user answered; `answers` maps each question's prompt text to
 *    the chosen option label OR a free-text custom answer (the engine folds this
 *    into the SDK dialog reply's `updatedInput.answers`).
 *  - `cancel` — the user dismissed/skipped; the engine settles the SDK dialog as
 *    `cancelled`, so the model proceeds without an answer (the SDK default).
 */
export const QuestionAnswerSchema = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('answer'),
    /** Question prompt text → chosen option label or free-text answer. For a
     *  multiSelect question the value is the selected labels joined with `, `. */
    answers: z.record(z.string(), z.string()),
  }),
  z.object({
    behavior: z.literal('cancel'),
  }),
]);
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
