import type { OnboardingPrerequisites } from '@/lib/bridge';

export type OnboardingStep = 'welcome' | 'environment' | 'project' | 'ready';

export type GitState = 'unknown' | 'checking' | 'valid' | 'invalid';

export interface OnboardingProps {
  folder: string | null;
  gitState: GitState;
  /** The active agent provider (`claude` / `codex`) from settings. Only when it's
   *  `codex` does the Codex CLI become a REQUIRED prerequisite; a Claude-only user
   *  (the primary persona) passes the gate without it. Defaults to `claude`. */
  activeProvider?: string;
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
  /** The active provider (resolved, defaulting to `claude`) — drives which tool
   *  checks are required vs optional. */
  activeProvider: string;
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
