import { noDeepPackageImportsRule } from '../../src/rules/no-deep-package-imports';
import { ruleTester } from '../test-utils/ruleTester';

ruleTester.run('no-deep-package-imports', noDeepPackageImportsRule, {
  valid: [
    // Barrel import — the only sanctioned form.
    { code: `import { TaskSchema } from '@nightcore/contracts';`, filename: 'apps/web/src/lib/bridge.ts' },
    // Non-nightcore deep imports are not this rule's concern.
    { code: `import { z } from 'zod/lib';`, filename: 'packages/contracts/src/index.ts' },
    // Re-export from the barrel.
    { code: `export { Foo } from '@nightcore/shared';`, filename: 'packages/engine/src/index.ts' },
  ],
  invalid: [
    // Deep subpath into a package's internals.
    {
      code: `import { thing } from '@nightcore/contracts/internal/thing';`,
      filename: 'apps/web/src/lib/bridge.ts',
      errors: [{ messageId: 'deepImport' }],
    },
    // Deep export-from.
    {
      code: `export { thing } from '@nightcore/engine/src/sdk-adapter';`,
      filename: 'packages/skills/src/index.ts',
      errors: [{ messageId: 'deepImport' }],
    },
    // Deep dynamic import.
    {
      code: `const m = await import('@nightcore/storage/dist/session-store');`,
      filename: 'packages/engine/src/store.ts',
      errors: [{ messageId: 'deepImport' }],
    },
  ],
});
