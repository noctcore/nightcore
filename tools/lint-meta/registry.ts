// @ts-check
import { agentContractParityRule } from './rules/agent-contract-parity';
import { agentsDocPresenceRule } from './rules/agents-doc-presence';
import { canonicalHelpersSingleHomeRule } from './rules/canonical-helpers-single-home';
import { codegenDriftRule } from './rules/codegen-drift';
import { decisionRegisterIntegrityRule } from './rules/decision-register-integrity';
import { layerRankRule } from './rules/layer-rank';
import { noClonedComponentFoldersRule } from './rules/no-cloned-component-folders';
import { noWarnSeverityRule } from './rules/no-warn-severity';
import { packageShapeRule } from './rules/package-shape';
import { rustCommandPlacementRule } from './rules/rust-command-placement';
import { rustEngineSeamRule } from './rules/rust-engine-seam';
import { rustLayerRankRule } from './rules/rust-layer-rank';
import { rustModuleShapeRule } from './rules/rust-module-shape';
import { scanFamilyParityRule } from './rules/scan-family-parity';
import { testRunnerSegregationRule } from './rules/test-runner-segregation';
import { testSiblingEnforcementRule } from './rules/test-sibling-enforcement';
import { testWorkspaceEnrollmentRule } from './rules/test-workspace-enrollment';
import { uiPrimitiveShapeRule } from './rules/ui-primitive-shape';
import { webFileSizeRatchetRule } from './rules/web-file-size-ratchet';
import { workspaceGraphParityRule } from './rules/workspace-graph-parity';
import type { IMetaRule } from './types';

/**
 * The cross-file / non-JS rules the lint-meta CLI runs. Add new rules here; a
 * `ciCritical` violation fails the gate.
 */
export const META_RULES: IMetaRule[] = [
  codegenDriftRule,
  agentContractParityRule,
  packageShapeRule,
  workspaceGraphParityRule,
  layerRankRule,
  noWarnSeverityRule,
  testWorkspaceEnrollmentRule,
  testRunnerSegregationRule,
  decisionRegisterIntegrityRule,
  agentsDocPresenceRule,
  uiPrimitiveShapeRule,
  scanFamilyParityRule,
  noClonedComponentFoldersRule,
  webFileSizeRatchetRule,
  rustModuleShapeRule,
  rustLayerRankRule,
  rustCommandPlacementRule,
  rustEngineSeamRule,
  canonicalHelpersSingleHomeRule,
  testSiblingEnforcementRule,
];
