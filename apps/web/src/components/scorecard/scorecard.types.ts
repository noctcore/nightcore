/** View-model types for the Scorecard surface: the normalized reading/evidence
 *  shapes the UI renders and the narrowed run/reading status unions. */
import type { ScorecardDimension, ScorecardGrade } from '@/lib/bridge';

/** Reading lifecycle, narrowed from the persisted `string`. UNLIKE Insight there is
 *  no `dismissed` state — a scorecard reading is either open or hardened. */
export type ReadingStatus = 'open' | 'converted';

/** A grounded evidence item as the view renders it (location nullable). */
export interface ScorecardEvidenceView {
  detail: string;
  location: {
    file: string;
    startLine: number | null;
    endLine: number | null;
    symbol: string | null;
  } | null;
}

/** A reading as the view renders it: the unified, union-typed shape both the live
 *  wire `ScorecardReading` (contract) and the persisted `StoredReading` (ts-rs)
 *  normalize into. */
export interface ScorecardReadingView {
  id: string;
  dimension: ScorecardDimension;
  grade: ScorecardGrade;
  title: string;
  summary: string;
  rationale: string | null;
  location: {
    file: string;
    startLine: number | null;
    endLine: number | null;
    symbol: string | null;
  } | null;
  suggestion: string | null;
  affectedFiles: string[];
  tags: string[];
  findings: ScorecardEvidenceView[];
  confidence: number | null;
  fingerprint: string;
  status: ReadingStatus;
  linkedTaskId: string | null;
}

/** A run-status drives the header chrome + whether controls are busy. */
export type RunStatus = 'idle' | 'running' | 'completed' | 'failed';
