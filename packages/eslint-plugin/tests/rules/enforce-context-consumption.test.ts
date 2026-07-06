import { enforceContextConsumptionRule } from '../../src/rules/enforce-context-consumption';
import { ruleTester } from '../test-utils/ruleTester';

// A board .types.ts file and its matching entry file.
const BOARD_TYPES = 'apps/web/src/components/board/TaskCard/TaskCard.types.ts';
const BOARD_ENTRY = 'apps/web/src/components/board/TaskCard/TaskCard.tsx';

// A compact stand-in for the real board registry (three scoped contexts).
const REGISTRY = {
  contexts: [
    {
      hook: 'useTaskActions',
      scope: 'board',
      providedProps: ['onRun', 'onCancel', 'onMerge'],
    },
    {
      hook: 'useBoardChrome',
      scope: 'board',
      providedProps: ['concurrency', 'autoMode'],
    },
    {
      hook: 'useWorktreesContext',
      scope: 'board',
      providedProps: ['worktrees'],
    },
  ],
};

const options = [REGISTRY] as const;

// A board Props contract that owns only non-context-provided props.
const cleanTypes = `
export interface TaskCardProps {
  task: Task;
  compact: boolean;
  onOpenSourceRef?: (ref: string) => void;
}
`;

// A single re-threaded action member.
const oneReThreadedMember = `
export interface TaskCardProps {
  task: Task;
  onRun: (id: string) => void;
}
`;

// Several re-threaded members across two contexts.
const manyReThreadedMembers = `
export interface TaskCardProps {
  onRun: (id: string) => void;
  onMerge: (id: string) => void;
  concurrency: number;
}
`;

// A re-threaded member on a type-alias (TSTypeLiteral) contract.
const typeAliasReThread = `
export type TaskCardProps = {
  task: Task;
  worktrees: WorktreeInfo[];
};
`;

// A method-signature form of the same member.
const methodSignatureReThread = `
export interface TaskCardProps {
  onRun(id: string): void;
}
`;

// A board entry file destructuring a re-threaded prop.
const entryReThread = `
export function TaskCard({ task, onRun }: TaskCardProps) {
  return null;
}
`;

// A board entry destructuring only owned props.
const entryClean = `
export function TaskCard({ task, compact }: TaskCardProps) {
  return null;
}
`;

// The context VALUE type (not a *Props) declaring the same members — the seam
// that DEFINES the context is never itself a re-thread.
const contextValueType = `
export interface TaskDetailActions {
  onRun: (id: string) => void;
  onMerge: (id: string) => void;
}
`;

ruleTester.run('enforce-context-consumption', enforceContextConsumptionRule, {
  valid: [
    // A board contract that declares no context-provided prop.
    { code: cleanTypes, filename: BOARD_TYPES, options },
    // A board entry that destructures only owned props.
    { code: entryClean, filename: BOARD_ENTRY, options },
    // Only `*Props` types are checked — the context value type is exempt.
    { code: contextValueType, filename: BOARD_TYPES, options },
    // A non-Props interface with a colliding member is not a contract.
    {
      code: `export interface TaskCardState {\n  onRun: () => void;\n}`,
      filename: BOARD_TYPES,
      options,
    },
    // Scope guard: an `insight` file is not enforced by a `board`-scoped entry.
    {
      code: oneReThreadedMember,
      filename: 'apps/web/src/components/insight/InsightView/InsightView.types.ts',
      options,
    },
    // The composition root renders the providers — no entry scopes to `app`.
    {
      code: oneReThreadedMember,
      filename: 'apps/web/src/components/app/AppShell/AppShell.types.ts',
      options,
    },
    // Outside components/ the rule never fires (feature is null).
    { code: oneReThreadedMember, filename: 'apps/web/src/lib/models.ts', options },
    // A feature-root module (not a `.types.ts`, not an entry) is not checked,
    // so the provider module that DEFINES the actions type is exempt.
    { code: contextValueType, filename: 'apps/web/src/components/board/actions.ts', options },
    // A non-entry `.tsx` (basename != folder) is not an entry shell.
    {
      code: entryReThread,
      filename: 'apps/web/src/components/board/TaskCard/Helper.tsx',
      options,
    },
    // Empty registry ⇒ nothing enforced.
    { code: oneReThreadedMember, filename: BOARD_TYPES, options: [{ contexts: [] }] },
  ],
  invalid: [
    // One re-threaded action member in a board contract.
    {
      code: oneReThreadedMember,
      filename: BOARD_TYPES,
      options,
      errors: [{ messageId: 'reThreaded', data: { name: 'onRun', hook: 'useTaskActions' } }],
    },
    // Multiple members across two contexts each report once.
    {
      code: manyReThreadedMembers,
      filename: BOARD_TYPES,
      options,
      errors: [
        { messageId: 'reThreaded', data: { name: 'onRun', hook: 'useTaskActions' } },
        { messageId: 'reThreaded', data: { name: 'onMerge', hook: 'useTaskActions' } },
        { messageId: 'reThreaded', data: { name: 'concurrency', hook: 'useBoardChrome' } },
      ],
    },
    // The type-alias (TSTypeLiteral) form is held to the same rule.
    {
      code: typeAliasReThread,
      filename: BOARD_TYPES,
      options,
      errors: [
        { messageId: 'reThreaded', data: { name: 'worktrees', hook: 'useWorktreesContext' } },
      ],
    },
    // A method-signature member is flagged like a property.
    {
      code: methodSignatureReThread,
      filename: BOARD_TYPES,
      options,
      errors: [{ messageId: 'reThreaded', data: { name: 'onRun', hook: 'useTaskActions' } }],
    },
    // A board entry file destructuring a re-threaded prop.
    {
      code: entryReThread,
      filename: BOARD_ENTRY,
      options,
      errors: [{ messageId: 'reThreaded', data: { name: 'onRun', hook: 'useTaskActions' } }],
    },
  ],
});
