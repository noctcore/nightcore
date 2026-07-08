import type { WelcomeFeature } from './WelcomeStep.types';

export function useWelcomeStep(): readonly WelcomeFeature[] {
  return [
    { title: 'Parallel agents', body: 'Queue work without losing the board state.' },
    { title: 'Isolated worktrees', body: 'Run changes away from your main checkout.' },
    { title: 'Human gates', body: 'Merge only what survives review and checks.' },
  ];
}
