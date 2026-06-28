/** Shared view-model types for the Insight surface: the normalized finding shape
 *  the UI renders and the run-status union that drives the header chrome. */
import type {
  FindingCategory,
  FindingEffort,
  FindingSeverity,
} from '@/lib/bridge';

/** Finding lifecycle, narrowed from the persisted `string`. */
export type FindingStatus = 'open' | 'dismissed' | 'converted';

/** A finding as the view renders it: the unified, union-typed shape both the live
 *  wire `Finding` (contract) and the persisted `StoredFinding` (ts-rs) normalize
 *  into. */
export interface InsightFinding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  effort: FindingEffort;
  title: string;
  description: string;
  rationale: string | null;
  location: {
    file: string;
    startLine: number | null;
    endLine: number | null;
    symbol: string | null;
  } | null;
  suggestion: string | null;
  codeBefore: string | null;
  codeAfter: string | null;
  affectedFiles: string[];
  tags: string[];
  confidence: number | null;
  fingerprint: string;
  status: FindingStatus;
  linkedTaskId: string | null;
}

/** A run-status drives the header chrome + whether controls are busy. */
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed';
