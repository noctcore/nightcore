/** The ConventionDetailPanel sheet for a single convention finding, composed from
 *  the shared GroundedFindingBody. */
import {
  DetailSection,
  GroundedFindingBody,
  type GroundedFindingView,
  GroundedLifecycleFooter,
} from '@/components/ui';
import { formatLocation } from '@/lib/formatters';

import { CATEGORY_META, KIND_META, SEVERITY_META } from '../harness.constants';
import type { ConventionFindingVM } from '../harness.types';
import type { ConventionDetailPanelProps } from './ConventionDetailPanel.types';

/** The convention detail sheet: full description, rationale, grounded evidence
 *  files, the rule to codify, tags, and the dismiss/restore lifecycle actions. */
export function ConventionDetailPanel({
  open,
  finding,
  pending,
  onClose,
  onConvert,
  onDismiss,
  onRestore,
  onGotoBoard,
}: ConventionDetailPanelProps) {
  const render = (shown: ConventionFindingVM): GroundedFindingView => {
    const sev = SEVERITY_META[shown.severity];
    const kind = KIND_META[shown.kind];
    const Meta = CATEGORY_META[shown.category];
    const Icon = Meta.icon;
    return {
      title: shown.title,
      badges: (
        <>
          <span
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${sev.chip} ${sev.tone}`}
          >
            {sev.label}
          </span>
          <span
            className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${kind.chip} ${kind.tone}`}
          >
            {kind.label}
          </span>
          <span className="inline-flex items-center gap-1 rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            <Icon size={11} />
            {Meta.label}
          </span>
          {shown.confidence !== null && (
            <span className="font-mono text-[10px] text-muted-foreground">
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
        rationale: shown.rationale,
        suggestion: shown.suggestion,
        suggestionTitle:
          shown.kind === 'gap' ? 'Change to adopt' : 'Rule to codify',
        extra: shown.evidence.length > 0 && (
          <DetailSection title="Evidence">
            <ul className="flex flex-col gap-1">
              {shown.evidence.map((e) => {
                const label = formatLocation(e, { withSymbol: true }) ?? e.file;
                return (
                  <li key={label}>
                    <code className="break-all font-mono text-[11.5px] text-muted-foreground">
                      {label}
                    </code>
                  </li>
                );
              })}
            </ul>
          </DetailSection>
        ),
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
