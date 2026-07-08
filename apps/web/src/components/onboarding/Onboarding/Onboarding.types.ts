import type { OnboardingPrerequisites } from '@/lib/bridge';

export type OnboardingStep = 'welcome' | 'environment' | 'project' | 'ready';

export type GitState = 'unknown' | 'checking' | 'valid' | 'invalid';

export interface OnboardingProps {
  folder: string | null;
  gitState: GitState;
  onChooseFolder: () => void | Promise<void>;
  onInitGit?: () => void | Promise<void>;
  onCreateProject: (name: string) => Promise<void>;
  onSkip: () => void;
  onComplete: () => void;
}

export interface OnboardingViewState {
  step: OnboardingStep;
  checks: OnboardingPrerequisites | null;
  checksLoading: boolean;
  checksError: string | null;
  appVersion: string | null;
  projectName: string;
  creating: boolean;
  canContinue: boolean;
  canCreateProject: boolean;
  envReady: boolean;
  goBack: () => void;
  goNext: () => void;
  rerunChecks: () => void;
  setProjectName: (value: string) => void;
  createProject: () => void;
}
