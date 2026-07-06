import { componentFolderStructureRule } from './component-folder-structure';
import { maxHooksPerFileRule } from './max-hooks-per-file';
import { maxPropsPerComponentRule } from './max-props-per-component';
import { noCrossFeatureImportsRule } from './no-cross-feature-imports';
import { noDeepPackageImportsRule } from './no-deep-package-imports';
import { noStateInComponentBodyRule } from './no-state-in-component-body';
import { wireMessageNamingRule } from './wire-message-naming';
import { zodSchemaNamingRule } from './zod-schema-naming';

export const rules = {
  // Frontend component architecture: folder-per-component convention under
  // components/<feature>/. Each component folder carries hooks/types/stories/
  // test/index; features stay decoupled; state lives in the colocated hook.
  'component-folder-structure': componentFolderStructureRule,
  'no-state-in-component-body': noStateInComponentBodyRule,
  'no-cross-feature-imports': noCrossFeatureImportsRule,
  'max-hooks-per-file': maxHooksPerFileRule,
  'max-props-per-component': maxPropsPerComponentRule,
  // Cross-package layering: consume @nightcore/<pkg> via its barrel only.
  'no-deep-package-imports': noDeepPackageImportsRule,
  // Contracts naming: exported zod schema = `*Schema` + sibling inferred type.
  'zod-schema-naming': zodSchemaNamingRule,
  // Wire-message naming: `type` discriminant = kebab(const minus role suffix).
  'wire-message-naming': wireMessageNamingRule,
};
