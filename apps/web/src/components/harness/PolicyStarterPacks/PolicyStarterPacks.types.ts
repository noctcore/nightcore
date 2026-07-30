/** Prop + pack types for the policy starter packs. */

/** The policy tiers a starter pack may write. A deliberate subset of the
 *  editor's list keys: a pack never touches `allowTools`, because handing a
 *  project a pre-canned AUTO-APPROVAL is the one direction where a wrong guess
 *  loosens the rails instead of tightening them. */
export type PolicyPackKey =
  | 'protectedPaths'
  | 'denyBashPatterns'
  | 'denyReadPaths'
  | 'disallowedTools'
  | 'askTools';

/** The draft's current entries for the pack-writable tiers — used to tell an
 *  already-applied pack from an available one. */
export type PolicyPackLists = Record<PolicyPackKey, readonly string[]>;

/** What a repo's shape tells us about which packs are relevant. A projection of
 *  the Harness scan's `RepoProfile` (the deterministic filesystem pass), narrowed
 *  to the fields the pack predicates actually read — so a profile field being
 *  added never silently changes which packs appear. */
export interface PolicyProfileHints {
  isMonorepo: boolean;
  languages: readonly string[];
  frameworks: readonly string[];
}

/** One curated policy preset. */
export interface PolicyStarterPack {
  id: string;
  title: string;
  /** Why this pack exists, in one line — what an agent breaks without it. */
  rationale: string;
  /** The entries it contributes, per tier. Merged into the draft (deduped);
   *  nothing is written to disk until the author saves. */
  entries: Partial<Record<PolicyPackKey, readonly string[]>>;
  /** `null` ⇒ relevant to every repo. Otherwise the profile predicate that must
   *  hold, plus the label explaining the keying to the user. */
  appliesTo: { label: string; matches: (profile: PolicyProfileHints) => boolean } | null;
}

/** Props for {@link import('./PolicyStarterPacks').PolicyStarterPacks}. */
export interface PolicyStarterPacksProps {
  /** Repo shape from the most recent Harness scan, or `null` when the project has
   *  never been scanned (then only the universal packs are offered). */
  profile: PolicyProfileHints | null;
  /** The draft's current entries, so an applied pack reads as applied. */
  current: PolicyPackLists;
  /** Merge a pack's entries into the draft. */
  onApply: (entries: Partial<Record<PolicyPackKey, readonly string[]>>) => void;
}
