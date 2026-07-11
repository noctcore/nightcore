import type { OnboardingPrerequisites } from '@/lib/bridge';

import { toolReady } from '../../Onboarding.hooks';
import type { ReadyCheck } from './ReadyStep.types';

/** The launch-ready checklist, BOUND to the real environment check results rather
 *  than hardcoded green. Reaching this step means a project was created (so the
 *  board line is always ready); the tool lines reflect their actual state. */
export function useReadyStep(checks: OnboardingPrerequisites | null): readonly ReadyCheck[] {
  return [
    { label: 'Claude Code', ready: checks !== null && toolReady(checks.claude) },
    { label: 'GitHub CLI', ready: checks !== null && toolReady(checks.gh), optional: true },
    { label: 'Git repository', ready: checks !== null && toolReady(checks.git) },
    // We only render this step after the project was created.
    { label: 'Project board', ready: true },
  ];
}
