import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  checkOnboardingPrerequisites,
  getAppInfo,
  type OnboardingPrerequisites,
  type ToolCheck,
} from '@/lib/bridge';

import type { OnboardingProps, OnboardingStep, OnboardingViewState } from './Onboarding.types';

const STEPS: OnboardingStep[] = ['welcome', 'environment', 'project', 'ready'];

export function folderBasename(folder: string | null): string {
  if (folder === null) return '';
  const normalized = folder.replace(/[/\\]+$/, '');
  return normalized.split(/[/\\]/).pop() ?? '';
}

export function toolReady(tool: ToolCheck): boolean {
  return tool.installed && tool.authenticated !== false;
}

export function prerequisitesReady(checks: OnboardingPrerequisites | null): boolean {
  return checks !== null && toolReady(checks.claude) && toolReady(checks.gh) && toolReady(checks.git);
}

export function useOnboarding({
  folder,
  gitState,
  onCreateProject,
  onComplete,
}: OnboardingProps): OnboardingViewState {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [checks, setChecks] = useState<OnboardingPrerequisites | null>(null);
  const [checksLoading, setChecksLoading] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('');
  const [creating, setCreating] = useState(false);

  const rerunChecks = useCallback(() => {
    setChecksLoading(true);
    setChecksError(null);
    void checkOnboardingPrerequisites()
      .then(setChecks)
      .catch((err) => {
        console.error('check_onboarding_prerequisites failed', err);
        setChecksError(err instanceof Error ? err.message : 'Could not run environment checks.');
      })
      .finally(() => setChecksLoading(false));
  }, []);

  useEffect(() => {
    rerunChecks();
  }, [rerunChecks]);

  useEffect(() => {
    let alive = true;
    void getAppInfo()
      .then((info) => {
        if (alive && info.version !== '0.0.0') setAppVersion(info.version);
      })
      .catch((err) => {
        console.error('app_info failed', err);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (projectName.trim().length > 0) return;
    setProjectName(folderBasename(folder));
  }, [folder, projectName]);

  const envReady = useMemo(() => prerequisitesReady(checks), [checks]);
  const canCreateProject =
    folder !== null && gitState === 'valid' && projectName.trim().length > 0 && !creating;

  const goBack = useCallback(() => {
    setStep((current) => STEPS[Math.max(0, STEPS.indexOf(current) - 1)] ?? 'welcome');
  }, []);

  const goNext = useCallback(() => {
    setStep((current) => {
      if (current === 'environment' && !envReady) return current;
      if (current === 'project') return current;
      return STEPS[Math.min(STEPS.length - 1, STEPS.indexOf(current) + 1)] ?? current;
    });
  }, [envReady]);

  const createProject = useCallback(() => {
    if (!canCreateProject) return;
    setCreating(true);
    void onCreateProject(projectName.trim())
      .then(() => {
        setStep('ready');
      })
      .catch(() => {
        // The parent flow owns the toast; keep the user on this step.
      })
      .finally(() => setCreating(false));
  }, [canCreateProject, onCreateProject, projectName]);

  useEffect(() => {
    if (step !== 'ready') return;
    const timeout = window.setTimeout(onComplete, 900);
    return () => window.clearTimeout(timeout);
  }, [onComplete, step]);

  return {
    step,
    checks,
    checksLoading,
    checksError,
    appVersion,
    projectName,
    creating,
    canContinue: step !== 'environment' || envReady,
    canCreateProject,
    envReady,
    goBack,
    goNext,
    rerunChecks,
    setProjectName,
    createProject,
  };
}
