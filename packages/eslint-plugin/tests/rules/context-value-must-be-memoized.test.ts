import { contextValueMustBeMemoizedRule } from '../../src/rules/context-value-must-be-memoized';
import { ruleTester } from '../test-utils/ruleTester';

const TSX = 'apps/web/src/components/board/TaskDetail/TaskDetail.tsx';

// A memoized (stable) value passed to a `.Provider` — the correct shape.
const stableProviderValue = `
export function TaskDetail({ value }: Props) {
  return <TaskStreamContext.Provider value={value}>{null}</TaskStreamContext.Provider>;
}
`;

// A bare-context (React 19) provider with a stable value.
const stableBareContextValue = `
export function TaskDetail({ value }: Props) {
  return <TaskStreamContext value={value}>{null}</TaskStreamContext>;
}
`;

// A non-context element with an inline object attribute is untouched.
const inlineStyleOnDiv = `
export function TaskDetail() {
  return <div style={{ color: 'red' }} />;
}
`;

// A custom wrapper component (not matched) may take an inline value — its own
// call site is where memoization is enforced, not here.
const customWrapperInlineValue = `
export function TaskDetail() {
  return <BoardChromeProvider value={{ a: 1 }}>{null}</BoardChromeProvider>;
}
`;

// An inline object literal on a `.Provider` — the churn the rule forbids.
const inlineObjectOnProvider = `
export function TaskDetail() {
  return <TaskStreamContext.Provider value={{ a: 1, b: 2 }}>{null}</TaskStreamContext.Provider>;
}
`;

// The React 19 bare-context form with an inline object.
const inlineObjectOnBareContext = `
export function TaskDetail() {
  return <TaskStreamContext value={{ a: 1 }}>{null}</TaskStreamContext>;
}
`;

ruleTester.run('context-value-must-be-memoized', contextValueMustBeMemoizedRule, {
  valid: [
    { code: stableProviderValue, filename: TSX },
    { code: stableBareContextValue, filename: TSX },
    { code: inlineStyleOnDiv, filename: TSX },
    { code: customWrapperInlineValue, filename: TSX },
    // A non-`.tsx` file is never scanned (JSX cannot appear there anyway).
    { code: `export const x = 1;`, filename: 'apps/web/src/components/board/actions.ts' },
  ],
  invalid: [
    {
      code: inlineObjectOnProvider,
      filename: TSX,
      errors: [{ messageId: 'inlineValue' }],
    },
    {
      code: inlineObjectOnBareContext,
      filename: TSX,
      errors: [{ messageId: 'inlineValue' }],
    },
  ],
});
