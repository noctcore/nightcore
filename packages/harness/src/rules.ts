/**
 * `@noctcore/harness/rules`: generic lint-meta rules a repo turns on in its
 * registry. Each export is a factory, `createXRule(options)`, returning an
 * {@link IMetaRule} for `harness lint-meta`. Options carry everything
 * repo-specific (paths, package lists, exemptions with reasons), so the rule
 * body never names a repo.
 *
 * Every rule here is strict: `ciCritical: true`, no `baseline`. A factory that
 * is handed a config that would check nothing (an empty package list, an
 * exemption with no reason) throws, so a registry with it fails to load
 * instead of passing quietly.
 *
 * Unlike the type-only root export, this subpath is a VALUE import: the repo
 * installs `@noctcore/harness` as a devDependency and its registry imports the
 * factories. It keeps the package promise: `node:*` builtins only, no network.
 */
import { GITHUB_ACTIONS_SECRET_NO_INSTALL_ID } from './rules/github-actions-secret-no-install.js';
import { GITHUB_ACTIONS_SECURITY_NO_CANCEL_ID } from './rules/github-actions-security-no-cancel.js';
import { LOCKFILE_REGISTRY_RESOLUTIONS_ID } from './rules/lockfile-registry-resolutions.js';
import { ONLY_BUILT_DEPENDENCIES_HAVE_SCRIPTS_ID } from './rules/only-built-dependencies-have-scripts.js';
import { PNPM_PATCH_LEDGER_ID } from './rules/pnpm-patch-ledger.js';
import { SINGLE_VERSION_DEPENDENCIES_ID } from './rules/single-version-dependencies.js';

export type { IMetaCtx, IMetaRule, IViolation } from './lint-meta/types.js';
export {
  checkSecretNoInstall,
  createGithubActionsSecretNoInstallRule,
  GITHUB_ACTIONS_SECRET_NO_INSTALL_ID,
  type IGithubActionsSecretNoInstallOptions,
  type ISecretExemption,
} from './rules/github-actions-secret-no-install.js';
export {
  checkSecurityWorkflowNoCancel,
  createGithubActionsSecurityNoCancelRule,
  GITHUB_ACTIONS_SECURITY_NO_CANCEL_ID,
  type IGithubActionsSecurityNoCancelOptions,
} from './rules/github-actions-security-no-cancel.js';
export {
  createLockfileRegistryResolutionsRule,
  type ILockfileRegistryResolutionsOptions,
  LOCKFILE_REGISTRY_RESOLUTIONS_ID,
} from './rules/lockfile-registry-resolutions.js';
export {
  createOnlyBuiltDependenciesHaveScriptsRule,
  ONLY_BUILT_DEPENDENCIES_HAVE_SCRIPTS_ID,
} from './rules/only-built-dependencies-have-scripts.js';
export {
  checkPnpmPatchLedger,
  createPnpmPatchLedgerRule,
  type IPnpmPatchLedgerOptions,
  patchFileHash,
  PNPM_PATCH_LEDGER_ID,
} from './rules/pnpm-patch-ledger.js';
export {
  createSingleVersionDependenciesRule,
  type ISingleVersionDependenciesOptions,
  SINGLE_VERSION_DEPENDENCIES_ID,
} from './rules/single-version-dependencies.js';

/**
 * Every rule id this subpath ships, in catalog order. A repo that keeps a local
 * rule must not reuse one of these ids (two implementations of one id drift).
 */
export const RULE_IDS: readonly string[] = [
  LOCKFILE_REGISTRY_RESOLUTIONS_ID,
  SINGLE_VERSION_DEPENDENCIES_ID,
  ONLY_BUILT_DEPENDENCIES_HAVE_SCRIPTS_ID,
  PNPM_PATCH_LEDGER_ID,
  GITHUB_ACTIONS_SECRET_NO_INSTALL_ID,
  GITHUB_ACTIONS_SECURITY_NO_CANCEL_ID,
];
