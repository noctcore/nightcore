import type { OnboardingViewState } from '../../Onboarding.types';

export type EnvironmentRowIcon = 'terminal' | 'key' | 'github' | 'checks';

export interface EnvironmentRowModel {
  id: string;
  label: string;
  detail: string;
  ready: boolean;
  fixHint: string;
  fixCommand: string;
  icon: EnvironmentRowIcon;
  optional?: boolean;
}

export interface EnvironmentStepProps {
  view: OnboardingViewState;
}

export interface EnvironmentStepState {
  rows: readonly EnvironmentRowModel[];
  animationDone: boolean;
  failedRequired: boolean;
  isCheckingRow: (index: number) => boolean;
}
