/** The Insight finding detail sheet, composed from the shared GroundedFindingBody. */
import {
  GroundedFindingBody,
  type GroundedFindingView,
  GroundedLifecycleFooter,
  inferLanguageFromFile,
} from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import {
  CATEGORY_META,
  EFFORT_META,
  SEVERITY_META,
} from '../insight.constants';
import type { InsightFinding } from '../insight.types';
import type { FindingDetailPanelProps } from './FindingDetailPanel.types';

/** The finding detail sheet: full description, rationale, grounded location,
 *  suggested fix, before/after, affected files, and the lifecycle actions. */
export function FindingDetailPanel({
  open,
  finding,
  pending,
  onClose,
  onConvert,
  onDismiss,
  onRestore,
  onGotoBoard,
}: FindingDetailPanelProps) {
  const render = (shown: InsightFinding): GroundedFindingView => {
    const sev = SEVERITY_META[shown.severity];
    const Meta = CATEGORY_META[shown.category];
    const Icon = Meta.icon;
    return {
      title: shown.title,
      badges: (
        <>
          <span
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-3xs font-semibold ${sev.chip} ${sev.tone}`}
          >
            {sev.label}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
            <Icon size={11} />
            {Meta.label}
          </span>
          <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
            {EFFORT_META[shown.effort].label} effort
          </span>
          {shown.confidence !== null && (
            <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
              {Math.round(shown.confidence * 100)}% confidence
            </span>
          )}
        </>
      ),
      footer: (
        <GroundedLifecycleFooter
          status={shown.status}
          pending={pending}
          onConvert={() => onConvert(shown.id)}
          onDismiss={() => onDismiss(shown.id)}
          onRestore={() => onRestore(shown.id)}
          onGotoBoard={onGotoBoard}
        />
      ),
      sections: {
        description: shown.description,
        location: formatLocation(shown.location, { withSymbol: true }),
        rationale: shown.rationale,
        suggestion: shown.suggestion,
        codeBefore: shown.codeBefore,
        codeAfter: shown.codeAfter,
        language: inferLanguageFromFile(shown.location?.file),
        affectedFiles: shown.affectedFiles,
        tags: shown.tags,
      },
    };
  };

  return (
    <GroundedFindingBody
      open={open}
      item={finding}
      onClose={onClose}
      render={render}
    />
  );
}
