import { maxPropsPerComponentRule } from '../../src/rules/max-props-per-component';
import { ruleTester } from '../test-utils/ruleTester';

const TYPES = 'apps/web/src/components/board/Board/Board.types.ts';

function props(count: number): string {
  return Array.from({ length: count }, (_, i) => `  p${i}: string;`).join('\n');
}

const twelvePropsInterface = `
export interface BoardProps {
${props(12)}
}
`;

const thirteenPropsInterface = `
export interface BoardProps {
${props(13)}
}
`;

const thirteenPropsTypeAlias = `
export type BoardProps = {
${props(13)}
};
`;

// Inherited members are free: only the LOCALLY-declared surface counts.
const extendsWithLocalTwelve = `
interface BasePartProps {
${props(10)}
}
export interface BoardProps extends BasePartProps {
${props(12).replace(/p(\d+):/g, 'q$1:')}
}
`;

const methodSignatures = `
export interface BoardProps {
${props(12)}
  onSelect(id: string): void;
}
`;

ruleTester.run('max-props-per-component', maxPropsPerComponentRule, {
  valid: [
    // Exactly the max is fine.
    { code: twelvePropsInterface, filename: TYPES },
    // Type-alias form at the max is fine too.
    {
      code: `export type BoardProps = {\n${props(12)}\n};`,
      filename: TYPES,
    },
    // Non-Props types are unconstrained.
    {
      code: `export interface BoardState {\n${props(20)}\n}`,
      filename: TYPES,
    },
    // Outside components/ the rule never fires.
    {
      code: thirteenPropsInterface,
      filename: 'apps/web/src/lib/models.ts',
    },
    // `extends` members are NOT counted — 10 inherited + 12 local passes.
    { code: extendsWithLocalTwelve, filename: TYPES },
    // A non-literal alias (union/mapped) is not a countable contract.
    {
      code: `type OtherProps = { a: string };\nexport type BoardProps = OtherProps | { b: string };`,
      filename: TYPES,
    },
    // A raised max permits more props.
    { code: thirteenPropsInterface, filename: TYPES, options: [{ max: 40 }] },
  ],
  invalid: [
    // 13 locally-declared members reds the default max of 12.
    {
      code: thirteenPropsInterface,
      filename: TYPES,
      errors: [{ messageId: 'tooManyProps' }],
    },
    // The type-alias (TSTypeLiteral) form is held to the same cap.
    {
      code: thirteenPropsTypeAlias,
      filename: TYPES,
      errors: [{ messageId: 'tooManyProps' }],
    },
    // Method signatures count as members: 12 properties + 1 method = 13.
    {
      code: methodSignatures,
      filename: TYPES,
      errors: [{ messageId: 'tooManyProps' }],
    },
    // A lowered max tightens the cap.
    {
      code: twelvePropsInterface,
      filename: TYPES,
      options: [{ max: 11 }],
      errors: [{ messageId: 'tooManyProps' }],
    },
    // The freeze-at-worst carve-out ceiling still reds when exceeded.
    {
      code: `export interface BoardProps {\n${props(41)}\n}`,
      filename: TYPES,
      options: [{ max: 40 }],
      errors: [{ messageId: 'tooManyProps' }],
    },
  ],
});
