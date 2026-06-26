import type { TSESTree } from '@typescript-eslint/utils';

import { createRule } from '../utils/createRule';

export const RULE_NAME = 'no-deep-package-imports';

type MessageIds = 'deepImport';

/*
 * A workspace package is consumed only through its `@nightcore/<pkg>` barrel.
 * A deep subpath (`@nightcore/<pkg>/internal/thing`) reaches past the barrel
 * into internals, defeating the documented layering spine. If a deep entry is
 * genuinely intended, add an explicit `exports` subpath to that package rather
 * than relaxing this rule.
 */
const DEEP_IMPORT = /^@nightcore\/[^/]+\/.+$/;

function barrelOf(source: string): string {
  const [scope, pkg] = source.split('/');
  return `${scope}/${pkg}`;
}

function literalString(node: TSESTree.Node | null | undefined): string | null {
  return node && node.type === 'Literal' && typeof node.value === 'string'
    ? node.value
    : null;
}

export const noDeepPackageImportsRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description:
        'Workspace packages must be consumed through their `@nightcore/<pkg>` barrel only — never via a deep subpath into package internals.',
    },
    schema: [],
    messages: {
      deepImport:
        "Deep import `{{source}}` reaches into a package's internals. Import the barrel `{{barrel}}` instead; if a deep entry is truly intended, add an explicit `exports` subpath to that package.",
    },
  },
  defaultOptions: [],
  create(context) {
    function check(node: TSESTree.Node, source: string | null): void {
      if (source !== null && DEEP_IMPORT.test(source)) {
        context.report({
          node,
          messageId: 'deepImport',
          data: { source, barrel: barrelOf(source) },
        });
      }
    }
    return {
      ImportDeclaration(node): void {
        check(node, literalString(node.source));
      },
      ExportNamedDeclaration(node): void {
        check(node, literalString(node.source));
      },
      ExportAllDeclaration(node): void {
        check(node, literalString(node.source));
      },
      ImportExpression(node): void {
        check(node, literalString(node.source));
      },
    };
  },
});
