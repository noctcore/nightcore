// @ts-check
import { agentContractParityRule } from './rules/agent-contract-parity';
import { codegenDriftRule } from './rules/codegen-drift';
import type { IMetaRule } from './types';

/**
 * The cross-file / non-JS rules the lint-meta CLI runs. Add new rules here; a
 * `ciCritical` violation fails the gate.
 */
export const META_RULES: IMetaRule[] = [codegenDriftRule, agentContractParityRule];
