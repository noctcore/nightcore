/**
 * Per-kind agent presets (the engine half of task-kind behavior).
 *
 * `@nightcore/contracts` owns the `TaskKind` enum; the Rust core owns each kind's
 * ORCHESTRATION policy (whether it gets a worktree, whether it is verified after).
 * This module owns the other half: a kind's AGENT DEFINITION — the system-prompt
 * append, the allowed/denied toolset, and the default permission mode that the
 * `SessionRunner` threads into the SDK `Options`.
 *
 * Agent identity is kept engine-side: the core never reaches into a preset and
 * the engine never decides orchestration.
 */
import type { PermissionMode, TaskKind } from '@nightcore/contracts';

/** The write tools a read-only reviewer must never be able to call. Denied for
 *  the `review` kind so a reviewer can inspect but not mutate the worktree. */
export const WRITE_TOOLS: readonly string[] = [
  'Edit',
  'Write',
  'NotebookEdit',
  'MultiEdit',
  'ApplyPatch',
] as const;

/**
 * The agent-definition half of a task kind. Every field is optional: an absent
 * field means "inherit the session default", so the `build` preset (all absent)
 * leaves a session at its default behavior.
 */
export interface KindPreset {
  /** Appended to the session's system prompt (SDK `appendSystemPrompt`). */
  appendSystemPrompt?: string;
  /** Tools to explicitly allow (SDK `allowedTools`). */
  allowedTools?: string[];
  /** Tools to deny (SDK `disallowedTools`). */
  disallowedTools?: string[];
  /** A DEFAULT permission mode for the kind. An explicit `command.permissionMode`
   *  always wins over this — it is only consulted when the command omits one. */
  permissionMode?: PermissionMode;
}

/**
 * The reviewer's agent identity. The per-run instructions (which diff to read,
 * the base branch, the `VERDICT:` line format) are supplied by the Rust core as
 * the session prompt; this append establishes the read-only-judge persona and the
 * fail-closed discipline so the persona can't drift run to run.
 */
const REVIEWER_SYSTEM_PROMPT = [
  'You are an independent code reviewer. You did not write this code.',
  'You are READ-ONLY: you cannot edit, write, or apply patches — only inspect.',
  'Judge the changes for correctness and completeness against the stated task,',
  'then end your final message with exactly one machine-readable line:',
  '`VERDICT: PASS`, `VERDICT: CHANGES_REQUESTED`, or `VERDICT: FAIL`.',
  'If you are uncertain or cannot complete the review, return `VERDICT: FAIL`.',
].join(' ');

/**
 * The test-first persona for the `tdd` kind. Orchestrated exactly like `build`
 * (own worktree + verification gate); only this persona differs — it forces the
 * red→green→refactor discipline so a TDD task can't drift into write-impl-first.
 */
const TDD_SYSTEM_PROMPT = [
  'You practice strict test-driven development.',
  'For the requested change, ALWAYS work in this order:',
  '(1) write a failing test that specifies the desired behavior;',
  '(2) run it and confirm it fails for the right reason;',
  '(3) write the minimum implementation to make it pass;',
  '(4) re-run and confirm green; then refactor with the test as a safety net.',
  'Never write implementation code before the test that requires it.',
  'Keep the existing test suite green throughout.',
].join(' ');

/**
 * The planning persona for the `decompose` kind. It investigates read-only and
 * proposes sub-tasks; the ENGINE parses a JSON array out of its final message
 * (via the shared `extractJson` + a `{ title, prompt }` schema → validated
 * `proposedSubtasks` on the `session-completed` event), and the user converts each
 * proposal into a board task. Write tools are denied so a decompose run can never
 * mutate the project.
 */
const DECOMPOSE_SYSTEM_PROMPT = [
  'You are a planning agent that breaks a goal into small, independently-shippable',
  'sub-tasks. You investigate the codebase read-only — you do NOT write code or edit',
  'files. When your analysis is complete, END your final message with a JSON array of',
  'sub-task objects, each with a string "title" (a short imperative title) and a string',
  '"prompt" (a self-contained task description). A fenced ```json block is fine, e.g.:',
  '\n```json\n[{"title": "...", "prompt": "..."}]\n```\n',
  'Propose between 2 and 8 sub-tasks ordered so each builds on the ones before it. If',
  'the goal needs no decomposition, end with an empty array.',
].join(' ');

/**
 * Resolve a task kind to its agent preset. `build`/`research` carry no overrides —
 * they inherit every session default, so their runs are unchanged. `review` is the
 * internal verification reviewer; `tdd` adds a test-first persona; `decompose`
 * adds a read-only planning persona that ends with a JSON sub-task array (parsed
 * by the engine into `proposedSubtasks`).
 */
export function resolveKindPreset(kind: TaskKind | undefined): KindPreset {
  switch (kind) {
    case 'review':
      return {
        appendSystemPrompt: REVIEWER_SYSTEM_PROMPT,
        disallowedTools: [...WRITE_TOOLS],
        // Verification is unattended; `dontAsk` never prompts. A tool that would
        // need a prompt is refused, so the reviewer can't hang the gate.
        permissionMode: 'dontAsk',
      };
    case 'tdd':
      // Build-like: writes code, so no tool restriction; only the persona differs.
      return { appendSystemPrompt: TDD_SYSTEM_PROMPT };
    case 'decompose':
      // Read-only analysis: deny writes so it can only propose, never mutate.
      return {
        appendSystemPrompt: DECOMPOSE_SYSTEM_PROMPT,
        disallowedTools: [...WRITE_TOOLS],
      };
    case 'build':
    case 'research':
    case undefined:
      return {};
  }
}
