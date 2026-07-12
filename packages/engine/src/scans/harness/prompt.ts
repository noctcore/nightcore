/**
 * The Harness per-lens user prompt builders, extracted from `manager.ts` so the
 * orchestrator stays under its file-size ratchet (the same split Insight/scan-manager
 * used). Pure string assembly: given the resolved command + preset + deterministic
 * profile + inventory, produce the convention pass prompt. Deep mode (issue #294)
 * threads a per-round findings cap and an exclusion list of already-found conventions
 * so each round elicits NEW, distinct findings.
 */
import type {
  ConventionFinding,
  RepoProfile,
  SurfaceCommand,
} from '@nightcore/contracts';

import { conventionOutputContract, type HarnessPreset } from './presets.js';
import { summarizeProfile } from './synthesis.js';

type StartHarnessScan = Extract<SurfaceCommand, { type: 'start-harness-scan' }>;

/** Findings cap per convention pass (the classic single-pass volume). */
export const MAX_FINDINGS_PER_CATEGORY = 8;

/** The per-run user prompt for a convention pass. The whole repo is always scanned
 *  (conventions are repo-wide), so there is no scope branch. The deterministic
 *  profile + top-level inventory are injected so the lens starts from a known map
 *  instead of re-discovering the same structure on every pass. `maxFindings` caps the
 *  pass (8 single-pass, `maxFindingsPerRound` in deep mode); a non-empty `exclusions`
 *  (deep mode's round ≥ 2) appends the already-found list and flips the output contract
 *  to "NEW findings not already listed above". With the defaults the output is
 *  byte-identical to the classic single-pass prompt. */
export function buildCategoryPrompt(
  command: StartHarnessScan,
  preset: HarnessPreset,
  profile: RepoProfile,
  inventory: string,
  maxFindings: number = MAX_FINDINGS_PER_CATEGORY,
  exclusions: readonly ConventionFinding[] = [],
): string {
  const newOnly = exclusions.length > 0;
  const lines = [
    `You are auditing the CONVENTIONS of the project at: ${command.projectPath}`,
    `Convention lens: ${preset.label}.`,
    '',
    'REPO PROFILE (deterministically detected — start from this, do not re-derive it):',
    summarizeProfile(profile),
    '',
    'REPO MAP (deterministic top-level inventory):',
    inventory,
    '',
    'Using the profile + map above, read the config, the entry points, and a ' +
      'representative sample of files for THIS lens — do not spend turns re-listing ' +
      'the tree — then identify the de-facto conventions and the gaps for this lens.',
  ];
  if (newOnly) {
    lines.push('', exclusionList(exclusions));
  }
  lines.push('', conventionOutputContract(maxFindings, newOnly));
  return lines.join('\n');
}

/** Render the deep-mode exclusion block for round ≥ 2: the titles (+ the first
 *  evidence anchor, when grounded) of every convention/gap accumulated in earlier
 *  rounds, so the model is told what NOT to re-report and steers toward NEW, distinct
 *  findings. Mirrors Insight's `exclusionList`, adapted to conventions' `evidence` list
 *  (a convention is often repo-wide/fileless, so the anchor is best-effort). */
function exclusionList(exclusions: readonly ConventionFinding[]): string {
  const items = exclusions.map((f) => {
    const anchor = f.evidence[0];
    const at = anchor
      ? ` (${anchor.file}${anchor.startLine !== undefined ? `:${anchor.startLine}` : ''})`
      : '';
    return `- ${f.title}${at}`;
  });
  return [
    'ALREADY FOUND in earlier rounds — do NOT report these again; find NEW, distinct conventions/gaps:',
    ...items,
  ].join('\n');
}
