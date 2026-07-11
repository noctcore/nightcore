import type { OnboardingPrerequisites } from '@/lib/bridge';

export interface ReadyCheck {
  label: string;
  /** The REAL readiness of this line (bound to the environment check results), not
   *  an always-green literal. */
  ready: boolean;
  /** Optional prerequisites (e.g. GitHub CLI) that aren't ready render as "skipped"
   *  rather than a failure — they don't block launch. */
  optional?: boolean;
}

export interface ReadyStepProps {
  /** The environment check results, or `null` before they resolve. */
  checks: OnboardingPrerequisites | null;
}
