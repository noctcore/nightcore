import type { ReadyCheck } from './ReadyStep.types';

export function useReadyStep(): readonly ReadyCheck[] {
  return [
    { label: 'Claude Code' },
    { label: 'GitHub CLI' },
    { label: 'Git repository' },
    { label: 'Project board' },
  ];
}
