/**
 * A real, self-contained ESLint plugin fixture for the RuleTester runner's tests
 * (issue #185). Exposes a `rules` map (the plugin shape the runner resolves against),
 * with one rule `no-forbidden` that reports any identifier named `forbidden`. Kept
 * dependency-free — the eslint types aren't a dependency of `@nightcore/engine`, so
 * the rule/context shapes are minimally typed inline.
 */

/** The subset of an ESLint AST identifier node the fixture rule reads. */
interface IdentifierNode {
  name: string;
}

/** The subset of the ESLint rule context the fixture rule uses. */
interface RuleContext {
  report(descriptor: { node: IdentifierNode; messageId: string }): void;
}

const noForbidden = {
  meta: {
    type: 'problem',
    docs: { description: 'disallow the identifier `forbidden`' },
    messages: { forbidden: 'The identifier `forbidden` is not allowed.' },
    schema: [],
  },
  create(context: RuleContext) {
    return {
      Identifier(node: IdentifierNode): void {
        if (node.name === 'forbidden') {
          context.report({ node, messageId: 'forbidden' });
        }
      },
    };
  },
};

export default { rules: { 'no-forbidden': noForbidden } };
