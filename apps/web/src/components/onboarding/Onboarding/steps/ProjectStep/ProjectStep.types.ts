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
  /** True while the offered `git init` is running — inerts + spins the button. */
  gitInitBusy: boolean;
  /** Run `git init`, tracking its in-flight state. No-op while already running. */
  runGitInit: () => void;
}
