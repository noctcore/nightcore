import { useCallback, useState } from 'react';

import type { OnboardingProps } from '../../Onboarding.types';
import type { ProjectStepState } from './ProjectStep.types';

export function useProjectStep(props: OnboardingProps): ProjectStepState {
  const [gitInitBusy, setGitInitBusy] = useState(false);
  const { onInitGit } = props;

  const runGitInit = useCallback(() => {
    if (onInitGit === undefined || gitInitBusy) return;
    setGitInitBusy(true);
    void Promise.resolve(onInitGit()).finally(() => setGitInitBusy(false));
  }, [onInitGit, gitInitBusy]);

  return { folderPicked: props.folder !== null, gitInitBusy, runGitInit };
}
