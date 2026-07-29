/** Starter packs for the runtime policy: curated deny/ask presets keyed on the
 *  repo's Harness profile, so a new project does not have to be authored from an
 *  empty textbox. Applying a pack edits the DRAFT — the author still reads the
 *  rules and saves them. */
import { Badge, Button, PlusIcon } from '@/components/ui';

import { usePolicyStarterPacks } from './PolicyStarterPacks.hooks';
import type { PolicyStarterPack, PolicyStarterPacksProps } from './PolicyStarterPacks.types';
import { packRuleCount } from './PolicyStarterPacks.utils';

/** One pack card: what it protects, why, and the add action. */
function PackCard({
  pack,
  applied,
  onApply,
}: {
  pack: PolicyStarterPack;
  applied: boolean;
  onApply: (pack: PolicyStarterPack) => void;
}) {
  const count = packRuleCount(pack);
  return (
    <div className="flex flex-col gap-1.5 rounded-[8px] border border-border bg-black/20 p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="text-2xs-plus font-semibold text-foreground">{pack.title}</span>
        {pack.appliesTo !== null && <Badge tone="info">{pack.appliesTo.label}</Badge>}
      </div>
      <p className="text-2xs leading-snug text-muted-foreground">{pack.rationale}</p>
      <div className="mt-auto flex items-center justify-between gap-2 pt-1">
        <span className="text-3xs text-muted-foreground/80">
          {count} rule{count === 1 ? '' : 's'}
        </span>
        {applied ? (
          <Badge tone="success">Added</Badge>
        ) : (
          <Button variant="ghost" onClick={() => onApply(pack)}>
            <PlusIcon size={12} />
            Add {pack.title.toLowerCase()}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The starter-pack strip. */
export function PolicyStarterPacks(props: PolicyStarterPacksProps) {
  const view = usePolicyStarterPacks(props);

  return (
    <div className="flex flex-col gap-2 rounded-nc border border-border bg-white/[0.015] p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h4 className="text-2xs-plus2 font-semibold text-foreground">Starter packs</h4>
          <p className="text-2xs text-muted-foreground">
            {props.profile === null
              ? 'Universal rails only — run a Harness scan to unlock the packs keyed to this repo’s stack.'
              : 'Curated rails for this repo’s shape. Added to the draft, not saved, so you review before they arm.'}
          </p>
        </div>
        <Button
          variant="ghost"
          onClick={view.toggle}
          aria-expanded={view.expanded}
          aria-controls="policy-starter-packs"
        >
          {view.expanded ? 'Hide' : `Show ${view.availableCount} available`}
        </Button>
      </div>
      {view.expanded && (
        <div
          id="policy-starter-packs"
          className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2 lg:grid-cols-3"
        >
          {view.offered.map((entry) => (
            <PackCard
              key={entry.pack.id}
              pack={entry.pack}
              applied={entry.applied}
              onApply={view.apply}
            />
          ))}
        </div>
      )}
    </div>
  );
}
