/** Pack selection + disclosure state for the policy starter packs. */
import { useCallback, useMemo, useState } from 'react';

import type {
  PolicyStarterPack,
  PolicyStarterPacksProps,
} from './PolicyStarterPacks.types';
import { packApplied, packsForProfile } from './PolicyStarterPacks.utils';

/** One offered pack plus whether the draft already contains all of it. */
export interface OfferedPack {
  pack: PolicyStarterPack;
  applied: boolean;
}

/** Everything the PolicyStarterPacks shell renders. */
export interface PolicyStarterPacksVM {
  /** The packs relevant to this repo, each with its applied state. */
  offered: OfferedPack[];
  /** Whether the pack strip is open. Opens itself for a policy with no rules — the
   *  case where authoring from zero is the actual problem — and stays closed once
   *  the project has rails of its own. */
  expanded: boolean;
  toggle: () => void;
  /** How many packs are not yet fully applied (the collapsed summary). */
  availableCount: number;
  apply: (pack: PolicyStarterPack) => void;
}

/** Own the pack strip: which packs this repo shape gets, which are already in the
 *  draft, and whether the strip starts open. */
export function usePolicyStarterPacks({
  profile,
  current,
  onApply,
}: PolicyStarterPacksProps): PolicyStarterPacksVM {
  const offered = useMemo(
    () =>
      packsForProfile(profile).map((pack) => ({
        pack,
        applied: packApplied(pack, current),
      })),
    [profile, current],
  );

  // Initial-render decision only: a project that arrives with an empty policy is
  // the one authoring from zero, so the packs are shown without a click. Later
  // edits never re-open the strip (that would fight the author).
  const [expanded, setExpanded] = useState(
    () => !Object.values(current).some((entries) => entries.length > 0),
  );
  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  return {
    offered,
    expanded,
    toggle,
    availableCount: offered.filter((entry) => !entry.applied).length,
    apply: useCallback((pack: PolicyStarterPack) => onApply(pack.entries), [onApply]),
  };
}
