import type { AnalysisScope, FindingCategory } from '@/lib/bridge';
import type { InsightStream } from '../insight-stream';

export interface RunControlsProps {
  stream: InsightStream;
  isStarting: boolean;
  disabled: boolean;
  onAnalyze: (
    scope: AnalysisScope,
    categories: FindingCategory[],
    model: string | null,
    effort: string | null,
  ) => void;
  onCancel: () => void;
}
