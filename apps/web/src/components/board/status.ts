/** Board status vocabulary: column definitions, status/kind/run-mode/verdict
 *  labels and colors, drag-eligibility rules, and model/cost formatters. */
import type { PermissionMode, RunMode, Task, TaskKind, TaskStatus } from '@/lib/bridge';
import { modelOptionFor } from '@/lib/models';

/** The DOM id on the board's search input, shared with the `/` focus-search shortcut so
 *  the app-shell keyboard layer can focus the field without threading a ref through the
 *  memoized Board. */
export const BOARD_SEARCH_INPUT_ID = 'board-search';

/** A board column: its key, label, the statuses it groups, its status
 *  dot color, and whether it offers a "Clear". */
export interface ColumnDef {
  key: string;
  title: string;
  statuses: TaskStatus[];
  /** oklch color for the column's status dot (and glow). */
  dotColor: string;
  /** Backlog/Done/Failed columns offer a "Clear" affordance when non-empty. */
  clearable?: boolean;
}

/** The six board columns, in display order:
 *  Backlog · In Progress · Verifying · Waiting Approval · Done · Failed. */
export const COLUMNS: ColumnDef[] = [
  {
    key: 'backlog',
    title: 'Backlog',
    statuses: ['backlog', 'ready'],
    dotColor: 'oklch(62% .02 290)',
    clearable: true,
  },
  {
    key: 'in_progress',
    title: 'In Progress',
    statuses: ['in_progress'],
    dotColor: 'oklch(80% .14 75)',
  },
  {
    key: 'verifying',
    title: 'Verifying',
    statuses: ['verifying'],
    dotColor: 'oklch(74% .13 280)',
  },
  {
    key: 'waiting_approval',
    title: 'Waiting Approval',
    statuses: ['waiting_approval'],
    dotColor: 'oklch(74% .13 248)',
  },
  {
    key: 'done',
    title: 'Done',
    statuses: ['done'],
    dotColor: 'oklch(76% .15 152)',
    clearable: true,
  },
  {
    key: 'failed',
    title: 'Failed',
    statuses: ['failed'],
    dotColor: 'oklch(66% .2 22)',
    clearable: true,
  },
];

/** Whether a column accepts a dragged card. In Progress and Verifying never do —
 *  both are engine-owned states with a live session, so a manual drop into them
 *  would strand a card in a running-looking state with no session behind it (and
 *  Verifying cards can't be dragged back out — see `canDragStatus`). Their
 *  droppables are inert. Keyed on the column's primary status (the dnd-kit
 *  droppable id). Mirrors `canDragStatus` so a card can never be dropped into a
 *  column it could not be dragged out of. */
export function isDroppableStatus(status: TaskStatus): boolean {
  return status !== 'in_progress' && status !== 'verifying';
}

/** Whether a card may be dragged between columns. A task that owns a live run
 *  (`in_progress` or `verifying`) is pinned — consistent with In Progress not
 *  being a drop target — so its card is not draggable. */
export function canDragStatus(status: TaskStatus): boolean {
  return status !== 'in_progress' && status !== 'verifying';
}

/** Human label for a status. */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'Running',
  verifying: 'Verifying',
  waiting_approval: 'Waiting Approval',
  done: 'Done',
  failed: 'Failed',
};

/** Whether a status represents an actively running session (pulses its dot). A
 *  `verifying` task holds a live reviewer session, so it pulses like `in_progress`. */
export function isActive(status: TaskStatus): boolean {
  return status === 'in_progress' || status === 'verifying';
}

/** Tailwind background class for a status dot. */
export const STATUS_DOT_COLOR: Record<TaskStatus, string> = {
  backlog: 'bg-muted',
  ready: 'bg-info',
  in_progress: 'bg-warning',
  verifying: 'bg-primary',
  waiting_approval: 'bg-info',
  done: 'bg-success',
  failed: 'bg-destructive',
};

/** Tailwind text class for a status label. */
export const STATUS_TEXT: Record<TaskStatus, string> = {
  backlog: 'text-muted-foreground',
  ready: 'text-info',
  in_progress: 'text-warning',
  verifying: 'text-primary',
  waiting_approval: 'text-info',
  done: 'text-success',
  failed: 'text-destructive',
};

/** Format a USD cost as a two-decimal dollar amount (e.g. `$0.42`). Re-exported
 *  from the shared `lib/formatters` home under its canonical name. */
export { formatCostUsd } from '@/lib/formatters';

/** The muted dot for an inherited (`Default`) or unrecognized model — never a
 *  guessed model's colour. */
const NEUTRAL_MODEL_DOT = 'oklch(62% .02 290)';

/** Compact a raw model id into a chip label when the shared catalog doesn't know it
 *  (a provider/model shipped ahead of Nightcore) — drop the provider prefix and turn
 *  the dashes into spaces, so an unknown id renders honestly as itself instead of a
 *  guessed default. */
function shortModelId(id: string): string {
  return id.replace(/^(claude|gpt|codex)-/i, '').replace(/-/g, ' ').trim() || id;
}

/** Human label for a model id, resolved through the shared model catalog
 *  (`@/lib/models`) so a Codex/Fable/unknown id renders HONESTLY — the old
 *  substring hack mapped every unrecognized id (and `null`) to "Opus 4.8" (and
 *  mislabelled Sonnet as 4.8). `null`/empty (inherit the provider default) → `Default`;
 *  a known id → its catalog label; an unknown id → a cleaned short form of the id. */
export function modelDisplayName(model: string | null): string {
  if (model === null || model.trim() === '') return 'Default';
  const option = modelOptionFor(model);
  return option !== null ? option.label : shortModelId(model);
}

/** The colored dot beside a model badge, keyed on the resolved model: Codex → teal,
 *  Sonnet → blue, Haiku → green, Opus/Fable (premium) → primary, and an
 *  inherit/unknown model → a neutral muted dot (never a guessed model's colour). */
export function modelDotColor(model: string | null): string {
  const option = model !== null ? modelOptionFor(model) : null;
  if (option === null) return NEUTRAL_MODEL_DOT;
  if (option.id.startsWith('gpt') || option.id.includes('codex')) return 'oklch(72% .15 165)';
  if (option.label.startsWith('Sonnet')) return 'oklch(74% .13 248)';
  if (option.label.startsWith('Haiku')) return 'oklch(76% .15 152)';
  return 'var(--nc-primary)';
}

/** The board badge for a task's model — the honest one (T13). Prefers the model the
 *  run ACTUALLY used (`actualModel`, captured from the engine's session event) over the
 *  requested `model` override (which is `null` for "inherit the provider default", the
 *  source of the old default-guess dishonesty). So a card reflects what ran, not a
 *  hardcoded fallback. Pure. */
export function modelBadge(
  task: Pick<Task, 'model' | 'actualModel'>,
): { label: string; dotColor: string } {
  const id = task.actualModel ?? task.model;
  return { label: modelDisplayName(id), dotColor: modelDotColor(id) };
}

// --- Task kinds -----------------------------------------------------------

/** A selectable kind in the create/edit picker. `enabled: false` renders the
 *  option as "coming soon" / disabled — defined on the wire but not yet driven by
 *  the engine (mirrors the contract's reserved variants). */
export interface KindOption {
  kind: TaskKind;
  label: string;
  /** One-line affordance description shown in the picker. */
  hint: string;
  /** Whether the option is selectable; false → disabled "coming soon". */
  enabled: boolean;
}

/** The kind picker's options, in display order. All four are selectable. `review`
 *  is intentionally absent — it is the internal verification-reviewer identity (the
 *  gate dispatches it automatically), not a kind a user creates a task as. */
export const KIND_OPTIONS: KindOption[] = [
  { kind: 'build', label: 'Build', hint: 'Write code in an isolated worktree, then verify', enabled: true },
  { kind: 'research', label: 'Research', hint: 'Investigate and report — no code changes', enabled: true },
  { kind: 'tdd', label: 'TDD', hint: 'Test-first: write the failing test, then implement', enabled: true },
  { kind: 'decompose', label: 'Decompose', hint: 'Split a goal into sub-tasks', enabled: true },
];

/** Human label for a task kind. Covers every `TaskKind` variant (including the
 *  picker-absent `review`) so the `Record` stays exhaustive. */
export const KIND_LABEL: Record<TaskKind, string> = {
  build: 'Build',
  research: 'Research',
  review: 'Review',
  decompose: 'Decompose',
  tdd: 'TDD',
};

// --- Run modes ------------------------------------------------------------

/** A selectable run mode in the create/edit form. `main` (default) edits
 *  the project tree in place; `worktree` isolates the task on its own branch. */
export interface RunModeOption {
  mode: RunMode;
  label: string;
  /** One-line explainer shown beneath the selector. */
  hint: string;
}

/** The run-mode selector's options, in display order — Main first (the default). */
export const RUN_MODE_OPTIONS: RunModeOption[] = [
  {
    mode: 'main',
    label: 'Main',
    hint: 'Edits the project directly on the current branch. No isolation.',
  },
  {
    mode: 'worktree',
    label: 'Worktree',
    hint: 'Isolates this task on its own branch in a separate worktree.',
  },
];

/** Human label for a run mode. */
export const RUN_MODE_LABEL: Record<RunMode, string> = {
  main: 'Main',
  worktree: 'Worktree',
};

// --- Verification verdict -------------------------------------------------

/** The parsed reviewer verdict. Mirrors the core's grep over the result text. */
export type Verdict = 'PASS' | 'CHANGES_REQUESTED' | 'FAIL';

/** Parse the machine-readable verdict from a reviewer's result text, matching the
 *  core's `VERDICT:\s*(PASS|CHANGES_REQUESTED|FAIL)` grep with last-match-wins.
 *  Returns `null` when no token is present (the core treats that as FAIL, but the
 *  UI distinguishes "unparseable" from an explicit FAIL for display). */
export function parseVerdict(review: string | null): Verdict | null {
  if (review === null) return null;
  const matches = [...review.matchAll(/VERDICT:\s*(PASS|CHANGES_REQUESTED|FAIL)/g)];
  const last = matches.at(-1);
  return last !== undefined ? (last[1] as Verdict) : null;
}

/** Tailwind text class for a parsed verdict. */
export const VERDICT_TEXT: Record<Verdict, string> = {
  PASS: 'text-success',
  CHANGES_REQUESTED: 'text-warning',
  FAIL: 'text-destructive',
};

/** Human label for a verdict. */
export const VERDICT_LABEL: Record<Verdict, string> = {
  PASS: 'Passed',
  CHANGES_REQUESTED: 'Changes requested',
  FAIL: 'Failed',
};

// --- Permission mode ------------------------------------------------------

/** A selectable permission-mode override in the per-task picker. The `null`
 *  (inherit) choice is rendered by the picker itself, not listed here. */
export interface PermissionModeOption {
  mode: PermissionMode;
  label: string;
  /** One-line explainer shown beneath the selector. */
  hint: string;
}

/** The permission-mode picker's options, in escalating-control order. `bypass`
 *  (the studio default) runs with no prompts; `plan` only proposes. */
export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  { mode: 'bypass', label: 'Bypass', hint: 'Runs autonomously — no approval prompts.' },
  { mode: 'auto-accept', label: 'Auto-accept', hint: 'Auto-approves edits; prompts on risky tools.' },
  { mode: 'ask', label: 'Ask', hint: 'Prompts before risky tools (writes, edits, shell).' },
  { mode: 'plan', label: 'Plan', hint: 'Proposes a plan first — makes no changes until approved.' },
];

/** Human label for a permission mode (or the inherit fallback). */
export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = {
  bypass: 'Bypass',
  'auto-accept': 'Auto-accept',
  ask: 'Ask',
  plan: 'Plan',
};

// --- Model + effort -------------------------------------------------------

// The option sets live in `@/lib/models` (shared with Settings); re-exported here
// so existing `../status` imports keep working.
export {
  EFFORT_OPTIONS,
  type EffortOption,
  MODEL_OPTIONS,
  type ModelOption,
} from '@/lib/models';
