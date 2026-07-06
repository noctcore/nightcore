import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import type { JSONSchema4 } from '@typescript-eslint/utils/json-schema';

import { getFeatureName } from '../utils/component-architecture';
import { createRule } from '../utils/createRule';

export const RULE_NAME = 'max-props-per-component';

export interface MaxPropsPerComponentOptions {
  readonly max?: number;
}

type RuleOptions = [MaxPropsPerComponentOptions];
type MessageIds = 'tooManyProps';

/*
 * A `*Props` contract wider than `max` (default 12) members means the component
 * is doing too much — split it, or group related props into cohesive objects.
 * Counts LOCALLY-DECLARED top-level members only (`TSPropertySignature` /
 * `TSMethodSignature`): members inherited via an interface `extends` clause or
 * an intersection type are deliberately NOT counted, so composing a shared base
 * contract stays free while widening the local surface does not.
 */
const DEFAULT_MAX = 12;

const optionSchema: JSONSchema4 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    max: { type: 'integer', minimum: 1 },
  },
};

function countLocalMembers(members: readonly TSESTree.TypeElement[]): number {
  return members.filter(
    (member) =>
      member.type === AST_NODE_TYPES.TSPropertySignature ||
      member.type === AST_NODE_TYPES.TSMethodSignature,
  ).length;
}

export const maxPropsPerComponentRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'A `*Props` interface/type-literal in components/** may declare at most `max` (default 12) local members. `extends` clauses are not counted.',
    },
    schema: [optionSchema],
    messages: {
      tooManyProps:
        "'{{name}}' declares {{count}} props (max {{max}}). A props contract this wide means the component does too much — split the component or group related props into cohesive objects.",
    },
  },
  defaultOptions: [{ max: DEFAULT_MAX }],
  create(context, [options]) {
    const max = options.max ?? DEFAULT_MAX;
    // Props contracts are a component-architecture concern: only files under a
    // components/ root are constrained.
    if (getFeatureName(context.filename) === null) {
      return {};
    }

    function check(
      node: TSESTree.TSInterfaceDeclaration | TSESTree.TSTypeAliasDeclaration,
      count: number,
    ): void {
      if (count > max) {
        context.report({
          node: node.id,
          messageId: 'tooManyProps',
          data: { name: node.id.name, count, max },
        });
      }
    }

    return {
      TSInterfaceDeclaration(node): void {
        if (!node.id.name.endsWith('Props')) {
          return;
        }
        check(node, countLocalMembers(node.body.body));
      },
      TSTypeAliasDeclaration(node): void {
        if (!node.id.name.endsWith('Props')) {
          return;
        }
        if (node.typeAnnotation.type !== AST_NODE_TYPES.TSTypeLiteral) {
          return;
        }
        check(node, countLocalMembers(node.typeAnnotation.members));
      },
    };
  },
});
