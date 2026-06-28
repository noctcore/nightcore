/**
 * Shared `RuleTester` for the plugin's rule tests, wired to the
 * typescript-eslint parser (TS + JSX) and driven by Vitest's lifecycle hooks.
 */
import * as parser from '@typescript-eslint/parser';
import { RuleTester } from '@typescript-eslint/rule-tester';
import { afterAll, describe, it } from 'vitest';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.describeSkip = describe.skip;
RuleTester.it = it;
RuleTester.itOnly = it.only;
RuleTester.itSkip = it.skip;

/** Configured `RuleTester` instance the rule tests run their cases through. */
export const ruleTester = new RuleTester({
  languageOptions: {
    parser,
    parserOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      ecmaFeatures: {
        jsx: true,
      },
    },
  },
});
