import type { TSESTree } from '@typescript-eslint/utils';

import { createRule } from '../utils/createRule';

export const RULE_NAME = 'zod-schema-naming';

type MessageIds = 'schemaNaming' | 'missingType';

const SCHEMA_NAME = /^[A-Z][A-Za-z0-9]*Schema$/;
const SUFFIX = 'Schema';

/*
 * Discriminated-union member schemas intentionally carry a role suffix
 * (`SessionStartedEvent`, `RunTaskCommand`, `ListSessionsQuery`) instead of
 * `Schema` — their const-name → wire-discriminant contract is enforced by
 * `nightcore/wire-message-naming`, so they are carved out here. This carve-out
 * is what lets the rule run at `error` on the contracts source.
 */
const ROLE_SUFFIXES = ['Event', 'Command', 'Query'] as const;

function hasRoleSuffix(name: string): boolean {
  return ROLE_SUFFIXES.some((s) => name.endsWith(s) && name.length > s.length);
}

/*
 * Walk an expression down its call/member chain to the root identifier so
 * `z.object({...})`, `z.union([...])`, `z.string().min(1)` etc. all resolve to
 * the root `z`. Anything not rooted at `z` is not treated as a zod schema.
 */
function rootIdentifierName(node: TSESTree.Node | null | undefined): string | null {
  let current: TSESTree.Node | null | undefined = node;
  while (current) {
    switch (current.type) {
      case 'CallExpression':
        current = current.callee;
        break;
      case 'MemberExpression':
        current = current.object;
        break;
      case 'Identifier':
        return current.name;
      default:
        return null;
    }
  }
  return null;
}

export const zodSchemaNamingRule = createRule<[], MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every exported zod schema is a PascalCase const suffixed `Schema`, paired with a same-named inferred type (`export type Foo = z.infer<typeof FooSchema>`).',
    },
    schema: [],
    messages: {
      schemaNaming:
        'Exported zod schema `{{name}}` must be a PascalCase const ending in `Schema` (e.g. `FooSchema`).',
      missingType:
        'Schema `{{name}}` has no sibling `export type {{base}} = z.infer<typeof {{name}}>`. Export the inferred type instead of hand-authoring a duplicate.',
    },
  },
  defaultOptions: [],
  create(context) {
    const schemas: { node: TSESTree.Identifier; name: string }[] = [];
    const exportedTypes = new Set<string>();

    return {
      ExportNamedDeclaration(node): void {
        const decl = node.declaration;
        if (!decl) return;
        if (decl.type === 'VariableDeclaration') {
          for (const d of decl.declarations) {
            if (
              d.id.type === 'Identifier' &&
              d.init &&
              rootIdentifierName(d.init) === 'z'
            ) {
              if (hasRoleSuffix(d.id.name)) continue;
              if (!SCHEMA_NAME.test(d.id.name)) {
                context.report({
                  node: d.id,
                  messageId: 'schemaNaming',
                  data: { name: d.id.name },
                });
              } else {
                schemas.push({ node: d.id, name: d.id.name });
              }
            }
          }
        } else if (
          decl.type === 'TSTypeAliasDeclaration' ||
          decl.type === 'TSInterfaceDeclaration'
        ) {
          exportedTypes.add(decl.id.name);
        }
      },
      'Program:exit'(): void {
        for (const schema of schemas) {
          const base = schema.name.slice(0, -SUFFIX.length);
          if (!exportedTypes.has(base)) {
            context.report({
              node: schema.node,
              messageId: 'missingType',
              data: { name: schema.name, base },
            });
          }
        }
      },
    };
  },
});
