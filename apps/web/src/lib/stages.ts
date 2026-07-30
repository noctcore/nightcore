/** The five-stage governed lifecycle, as DATA — the single source of truth for what
 *  each stage is called, what it does, and what it leaves behind.
 *
 *  Nightcore's whole product thesis is a lifecycle: **Intake → Understand → Harden →
 *  Enforce → Verify**. Before this module the stage names existed only as sidebar
 *  group labels (`NavSidebar.hooks.ts`), so the model was transmitted by nothing —
 *  a new user was handed a board and expected to infer it (issue #404).
 *
 *  Everything that explains a stage reads from here: the onboarding wizard's stage
 *  diagram, the sidebar's per-stage explainers, and the nav row labels themselves
 *  (`nav.constants.tsx` takes each stage's single destination label from
 *  {@link StageMeta.destination}, so the nav and the explainer can never disagree).
 *
 *  `lib/` is the framework-neutral leaf: pure data, no React, no imports from
 *  `@/components/**`. */

/** The five workflow stages, in lifecycle order. Mirrors the sidebar's stage
 *  `NavGroupId`s (the non-stage `project` / `settings` groups are not stages). */
export type StageId = 'intake' | 'understand' | 'harden' | 'enforce' | 'verify';

/** What one stage IS: its name, its destination in the nav, the sentence that
 *  explains it, and the artifact it produces. */
export interface StageMeta {
  id: StageId;
  /** The stage name, as shown in the sidebar group header. */
  label: string;
  /** The nav row this stage routes to. `nav.constants.tsx` uses this AS the row
   *  label, so there is exactly one copy of the destination's name. */
  destination: string;
  /** A terse imperative for the stage's job — the diagram's headline. */
  verb: string;
  /** The explainer: what actually happens in this stage, in one or two sentences.
   *  Written to be read cold, by someone who has never seen the app. */
  summary: string;
  /** The concrete artifact the stage leaves behind — the reason to run it. */
  produces: string;
}

const INTAKE: StageMeta = {
  id: 'intake',
  label: 'Intake',
  destination: 'Issue Triage',
  verb: 'Decide what to build',
  summary:
    'Nightcore reads your GitHub issues, maps them into themes, and validates each one against the actual code before you commit to it — so a task starts from something real, not a stale issue.',
  produces: 'Validated tasks on the board',
};

const UNDERSTAND: StageMeta = {
  id: 'understand',
  label: 'Understand',
  destination: 'Find & Grade',
  verb: 'Learn the codebase',
  summary:
    'Find scans the repo for grounded findings, each pinned to a file and line you can open. Grade scores the same repo A–F across dimensions, so you know where it is weakest.',
  produces: 'Grounded findings and a repo scorecard',
};

const HARDEN: StageMeta = {
  id: 'harden',
  label: 'Harden',
  destination: 'Propose',
  verb: 'Propose the fix',
  summary:
    'What the scan found becomes concrete proposals — conventions, lint rules, and agent contracts. Nothing is written until you review a proposal and apply it.',
  produces: 'Reviewable proposals you apply one by one',
};

const ENFORCE: StageMeta = {
  id: 'enforce',
  label: 'Enforce',
  destination: 'Conventions',
  verb: 'Make it mechanical',
  summary:
    'A convention is only real once a machine checks it. This stage reports which conventions are enforced, which are documented only, and where coverage is missing.',
  produces: 'Enforced conventions and their coverage gaps',
};

const VERIFY: StageMeta = {
  id: 'verify',
  label: 'Verify',
  destination: 'PR Review',
  verb: 'Prove it before merge',
  summary:
    'Every change earns its merge. The Structure-Lock Gauntlet runs per task on the board and produces a trust report; PR Review reads the diff itself for a second opinion.',
  produces: 'A trust report per task, plus a diff review',
};

/** The lifecycle, in order. Index + 1 is the stage number shown in the diagram. */
export const STAGES: readonly StageMeta[] = [INTAKE, UNDERSTAND, HARDEN, ENFORCE, VERIFY];

/** Stage metadata by id — the lookup the nav and the explainers read. The `Record`
 *  annotation is the exhaustiveness guard: a new {@link StageId} that forgets its
 *  metadata is a type error, not a blank explainer. */
export const STAGE_BY_ID: Record<StageId, StageMeta> = {
  intake: INTAKE,
  understand: UNDERSTAND,
  harden: HARDEN,
  enforce: ENFORCE,
  verify: VERIFY,
};

/** The stage ids in lifecycle order — derived from {@link STAGES} so the order is
 *  declared exactly once (the sidebar's `GROUP_ORDER` frames these with its two
 *  non-stage groups). */
export const STAGE_ORDER: readonly StageId[] = STAGES.map((stage) => stage.id);

/** 1-based position of a stage in the lifecycle (the number shown in the diagram). */
export function stageNumber(id: StageId): number {
  return STAGE_ORDER.indexOf(id) + 1;
}
