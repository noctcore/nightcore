/** Presentation helpers for the Policy activity feed: turning a rule id into the
 *  WHY a human reads, and a timestamp into "4m ago".
 *
 *  The backend deliberately returns the raw `ruleId` rather than a sentence — the
 *  id is the stable, greppable fact shared with the ledger, the Trust Report and
 *  the engine's own logs. Labelling it is presentation, so it lives here. An
 *  UNKNOWN id renders as itself: a rail the UI has not learned about yet must
 *  still be visible and attributable, never swallowed. */
import type { PolicyActivityEntry } from '@/lib/bridge';

/** Rule id → the plain-language reason the call was stopped. Covers the harness
 *  policy tiers (this project's own rules) plus the built-in rails an author
 *  cannot edit but will absolutely see in the feed. */
const RULE_LABELS: Record<string, string> = {
  // The project's own policy (`.nightcore/harness.json`).
  'harness-protected-path': 'Write to a protected path',
  'harness-read-deny': 'Read of a denied path',
  'harness-bash-deny': 'Denied bash pattern',
  'harness-tool-deny': 'Disallowed tool',
  'harness-tool-ask': 'Ask-first tool',
  // Built-in rails (the engine's always-on gates).
  'workspace-confinement': 'Target outside the workspace',
  'sensitive-read': 'Read of a credential store',
  'git-config-protection': 'Write to git configuration',
  'mcp-uncontained': 'Uncontained MCP server',
  'exec-sink-ask': 'Write to an execution sink',
  'rm-recursive-force': 'Recursive force delete',
  'pipe-to-shell': 'Piping a download into a shell',
  'network-exfiltration': 'Outbound data transfer',
  'privilege-escalation': 'Privilege escalation',
  'git-force-push': 'Force push',
  'git-reset-hard': 'Hard reset',
  'disk-destroy': 'Destructive disk write',
};

/** The human reason for an entry's rule, falling back to the id itself. */
export function ruleLabel(ruleId: string): string {
  return RULE_LABELS[ruleId] ?? ruleId;
}

/** Whether an entry came from a rule the author can edit. Drives the badge that
 *  keeps "your rule fired" apart from "a built-in rail fired" — implying the
 *  latter is editable would send the author hunting through their own policy. */
export function isProjectRule(entry: PolicyActivityEntry): boolean {
  return entry.source === 'policy';
}

/** A compact relative age for an ISO timestamp, or `null` when the record has no
 *  `ts` (a ledger line written before the recorder carried one). `now` is
 *  injected so the formatting is testable without freezing the clock. */
export function relativeAge(ts: string | null, now: number): string | null {
  if (ts === null) return null;
  const at = Date.parse(ts);
  if (Number.isNaN(at)) return null;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** How many entries came from the project's own policy — the headline number: it
 *  is the only count that says "the rules you wrote are doing something". */
export function projectRuleCount(entries: readonly PolicyActivityEntry[]): number {
  return entries.filter(isProjectRule).length;
}
