/** Bridge commands for first-run onboarding diagnostics. */

import { tauriInvoke } from '../internal';
import { MOCK_ONBOARDING_PREREQUISITES } from '../mocks';
import type { OnboardingPrerequisites } from '../types';

export async function checkOnboardingPrerequisites(): Promise<OnboardingPrerequisites> {
  return tauriInvoke<OnboardingPrerequisites>(
    'check_onboarding_prerequisites',
    {},
    MOCK_ONBOARDING_PREREQUISITES,
  );
}
