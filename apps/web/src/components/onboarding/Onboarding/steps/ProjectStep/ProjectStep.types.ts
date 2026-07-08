import type {
  OnboardingProps,
  OnboardingViewState,
} from '../../Onboarding.types';

export interface ProjectStepProps {
  props: OnboardingProps;
  view: OnboardingViewState;
}

export interface ProjectStepState {
  folderPicked: boolean;
}
