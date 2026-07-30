import type { OnboardingPrerequisites } from '@/lib/bridge';

export type OnboardingStep = 'welcome' | 'stages' | 'environment' | 'project' | 'ready';

export type GitState = 'unknown' | 'checking' | 'valid' | 'invalid';

/** Where the wizard hands the user off when it finishes. `board` is the default
 *  (the project's Kanban board); `scan` lands on the Understand stage so the
 *  optional first-scan CTA actually starts them in the lifecycle instead of just
 *  describing it. Deliberately NOT the shell's `AppView` union — onboarding names
 *  an INTENT and the shell maps it to a route. */
export type OnboardingLanding = 'board' | 'scan';

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
  /** Leave the wizard for the app. The landing tells the shell WHERE to hand off —
   *  the board, or the Understand stage when the user took the first-scan CTA. */
  onComplete: (landing: OnboardingLanding) => void;
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
