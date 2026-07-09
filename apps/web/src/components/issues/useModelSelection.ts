import { useState } from 'react';

/** Small state bag for the model/effort/provider picker (used by issue validation).
 * Extracted to keep the main view hook under the file-size ratchet. */
export interface ModelSelection {
  model: string | null;
  effort: string | null;
  providerId: string | null;
  setModel: (v: string | null) => void;
  setEffort: (v: string | null) => void;
  setProviderId: (v: string | null) => void;
}

export function useModelSelection(): ModelSelection {
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | null>(null);
  return { model, setModel, effort, setEffort, providerId, setProviderId };
}

/** Pure badge derivation extracted from the view hook (keeps main hook file under ratchet). */
export function computeIssueValidationBadges(
  issues: Array<{ number: number; updatedAt: string }>,
  runs: Array<{ issueNumber: number; status: string; updatedAt: number }>,
): Record<number, 'stale' | 'validated'> {
  const map: Record<number, 'stale' | 'validated'> = {};
  const issueByNumber = new Map(issues.map((i) => [i.number, i]));
  const seen = new Set<number>();
  for (const run of runs) {
    if (seen.has(run.issueNumber)) continue;
    seen.add(run.issueNumber);
    if (run.status !== 'completed') continue;
    const issue = issueByNumber.get(run.issueNumber);
    const isStale = issue !== undefined && Date.parse(issue.updatedAt) > run.updatedAt;
    map[run.issueNumber] = isStale ? 'stale' : 'validated';
  }
  return map;
}
