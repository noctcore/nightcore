import { componentFolderStructureRule } from '../../src/rules/component-folder-structure';
import { ruleTester } from '../test-utils/ruleTester';

const COMPONENT = `export default function Widget() { return null; }`;

// Paths resolve relative to the package root (vitest cwd); the fixtures under
// tests/fixtures/components/** carry the sibling sets these cases assert on.
ruleTester.run('component-folder-structure', componentFolderStructureRule, {
  valid: [
    // A component folder whose full sibling set is present on disk.
    {
      code: COMPONENT,
      filename: 'tests/fixtures/components/board/Complete/Complete.tsx',
    },
    // Nested component folders are still component folders and must be checked.
    {
      code: COMPONENT,
      filename:
        'tests/fixtures/components/onboarding/Onboarding/steps/DeepStep/DeepStep.tsx',
    },
    // Kebab-case file is not a component entry file — skipped.
    {
      code: COMPONENT,
      filename: 'apps/web/src/components/board/task-card.tsx',
    },
    // Basename does not equal parent folder — not a component entry file.
    {
      code: COMPONENT,
      filename: 'apps/web/src/components/board/Group/Widget.tsx',
    },
    // components/ui keeps the shadcn convention — excluded via ignorePaths.
    {
      code: COMPONENT,
      filename: 'apps/web/src/components/ui/Button/Button.tsx',
    },
    // A component file outside components/** is not gated.
    {
      code: COMPONENT,
      filename: 'apps/web/src/routes/Widget/Widget.tsx',
    },
  ],
  invalid: [
    // A component folder on disk that is missing its entire sibling set.
    {
      code: COMPONENT,
      filename: 'tests/fixtures/components/board/Widget/Widget.tsx',
      errors: [{ messageId: 'missingSiblings' }],
    },
    // A nested component folder on disk is also gated by the sibling set.
    {
      code: COMPONENT,
      filename:
        'tests/fixtures/components/onboarding/Onboarding/steps/ShallowStep/ShallowStep.tsx',
      errors: [{ messageId: 'missingSiblings' }],
    },
  ],
});
