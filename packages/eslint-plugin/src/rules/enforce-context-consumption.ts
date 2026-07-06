import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import type { JSONSchema4 } from '@typescript-eslint/utils/json-schema';

import {
  getBasename,
  getFeatureName,
  isComponentEntryFile,
} from '../utils/component-architecture';
import { createRule } from '../utils/createRule';

export const RULE_NAME = 'enforce-context-consumption';

/** One registered context: the hook that reads it, the feature it is enforced
 *  in, and the prop names it supplies. */
export interface ContextRegistryEntry {
  /** The consumer hook (`useTaskActions`) — named in the error message. */
  readonly hook: string;
  /** The feature (first segment under `components/`) this context applies to.
   *  A registry entry is active only for files whose feature equals `scope`. */
  readonly scope: string;
  /** The prop names the context supplies — declaring any of them as a prop in a
   *  `scope`-feature component re-threads what the context already provides. */
  readonly providedProps: readonly string[];
}

export interface EnforceContextConsumptionOptions {
  readonly contexts?: readonly ContextRegistryEntry[];
}

type RuleOptions = [EnforceContextConsumptionOptions];
type MessageIds = 'reThreaded';

/*
 * The context-consumption lock-in (issue #56). Once a scoped context replaces a
 * drilled prop bundle (the board's `TaskActionsContext` / `BoardChromeContext` /
 * `WorktreesContext`), this rule keeps it replaced: a `*Props` member — or a
 * destructured prop in a component entry file — whose name a registered context
 * SUPPLIES is a re-thread, and the fix is to consume the context instead.
 *
 * Deliberately narrow, so the signal stays clean:
 *  - only files under a `components/<feature>/` root, and only when the feature
 *    matches a registry entry's `scope` (the composition root, which RENDERS the
 *    provider, has no matching scope and is exempt);
 *  - only `*Props` interfaces / type-literals in `*.types.ts`, and only props
 *    destructured from a `*Props`-annotated parameter in a component entry file
 *    (`<Name>/<Name>.tsx`);
 *  - never autofixable: consumption belongs in the colocated `.hooks.ts`
 *    (`no-state-in-component-body`), which a mechanical rewrite cannot place.
 * The `providedProps` list is curated per context to the drilled surface it
 * replaced — a name that legitimately remains a controlled-leaf prop (a reusable
 * primitive fed by the context consumer) is simply left out of the registry.
 */

const optionSchema: JSONSchema4 = {
  type: 'object',
  additionalProperties: false,
  properties: {
    contexts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['hook', 'scope', 'providedProps'],
        properties: {
          hook: { type: 'string' },
          scope: { type: 'string' },
          providedProps: {
            type: 'array',
            items: { type: 'string' },
            uniqueItems: true,
          },
        },
      },
    },
  },
};

type ComponentFunction =
  | TSESTree.FunctionDeclaration
  | TSESTree.FunctionExpression
  | TSESTree.ArrowFunctionExpression;

/** A reportable `{ node, name }` for each Identifier-keyed member of a type. */
function typeMemberNames(
  members: readonly TSESTree.TypeElement[],
): { node: TSESTree.Node; name: string }[] {
  const out: { node: TSESTree.Node; name: string }[] = [];
  for (const member of members) {
    if (
      (member.type === AST_NODE_TYPES.TSPropertySignature ||
        member.type === AST_NODE_TYPES.TSMethodSignature) &&
      member.key.type === AST_NODE_TYPES.Identifier
    ) {
      out.push({ node: member.key, name: member.key.name });
    }
  }
  return out;
}

/** The `*Props`-annotated ObjectPattern parameter of a component fn, if any. */
function getPropsPattern(node: ComponentFunction): TSESTree.ObjectPattern | null {
  const param = node.params[0];
  if (param === undefined || param.type !== AST_NODE_TYPES.ObjectPattern) {
    return null;
  }
  const annotation = param.typeAnnotation?.typeAnnotation;
  if (
    annotation === undefined ||
    annotation.type !== AST_NODE_TYPES.TSTypeReference ||
    annotation.typeName.type !== AST_NODE_TYPES.Identifier ||
    !annotation.typeName.name.endsWith('Props')
  ) {
    return null;
  }
  return param;
}

/** A reportable `{ node, name }` for each Identifier-keyed destructured prop. */
function destructuredPropNames(
  pattern: TSESTree.ObjectPattern,
): { node: TSESTree.Node; name: string }[] {
  const out: { node: TSESTree.Node; name: string }[] = [];
  for (const property of pattern.properties) {
    if (
      property.type === AST_NODE_TYPES.Property &&
      !property.computed &&
      property.key.type === AST_NODE_TYPES.Identifier
    ) {
      out.push({ node: property.key, name: property.key.name });
    }
  }
  return out;
}

export const enforceContextConsumptionRule = createRule<RuleOptions, MessageIds>({
  name: RULE_NAME,
  meta: {
    type: 'problem',
    docs: {
      description:
        'A prop whose name a registered scoped context provides must be consumed from that context, not re-threaded as a prop. Keeps a completed context refactor from silently regrowing prop drilling.',
    },
    schema: [optionSchema],
    messages: {
      reThreaded:
        "'{{name}}' is provided by {{hook}}() — consume the context, do not re-thread it as a prop.",
    },
  },
  defaultOptions: [{ contexts: [] }],
  create(context, [options]) {
    const feature = getFeatureName(context.filename);
    if (feature === null) {
      return {};
    }
    // name -> hook, restricted to the contexts active for this file's feature.
    // The composition root renders the provider, so no entry scopes to it.
    const providedBy = new Map<string, string>();
    for (const entry of options.contexts ?? []) {
      if (entry.scope !== feature) {
        continue;
      }
      for (const prop of entry.providedProps) {
        if (!providedBy.has(prop)) {
          providedBy.set(prop, entry.hook);
        }
      }
    }
    if (providedBy.size === 0) {
      return {};
    }

    const isTypesFile = getBasename(context.filename).endsWith('.types.ts');
    const isEntry = isComponentEntryFile(context.filename);
    if (!isTypesFile && !isEntry) {
      return {};
    }

    function report(node: TSESTree.Node, name: string): void {
      const hook = providedBy.get(name);
      if (hook !== undefined) {
        context.report({ node, messageId: 'reThreaded', data: { name, hook } });
      }
    }

    if (isTypesFile) {
      return {
        TSInterfaceDeclaration(node): void {
          if (!node.id.name.endsWith('Props')) {
            return;
          }
          for (const { node: member, name } of typeMemberNames(node.body.body)) {
            report(member, name);
          }
        },
        TSTypeAliasDeclaration(node): void {
          if (
            !node.id.name.endsWith('Props') ||
            node.typeAnnotation.type !== AST_NODE_TYPES.TSTypeLiteral
          ) {
            return;
          }
          for (const { node: member, name } of typeMemberNames(
            node.typeAnnotation.members,
          )) {
            report(member, name);
          }
        },
      };
    }

    function checkFunction(node: ComponentFunction): void {
      const pattern = getPropsPattern(node);
      if (pattern === null) {
        return;
      }
      for (const { node: prop, name } of destructuredPropNames(pattern)) {
        report(prop, name);
      }
    }

    return {
      FunctionDeclaration: checkFunction,
      FunctionExpression: checkFunction,
      ArrowFunctionExpression: checkFunction,
    };
  },
});
