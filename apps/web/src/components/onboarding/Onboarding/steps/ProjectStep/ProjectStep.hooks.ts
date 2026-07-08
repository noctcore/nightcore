import type { OnboardingProps } from '../../Onboarding.types';
import type { ProjectStepState } from './ProjectStep.types';

export function useProjectStep(props: OnboardingProps): ProjectStepState {
  return { folderPicked: props.folder !== null };
}
