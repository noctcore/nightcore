import type { InsightFinding } from '../insight.types';

export interface FindingDetailPanelProps {
  finding: InsightFinding;
  pending: boolean;
  onClose: () => void;
  onConvert: (findingId: string) => void;
  onDismiss: (findingId: string) => void;
  onRestore: (findingId: string) => void;
  onGotoBoard?: () => void;
}
