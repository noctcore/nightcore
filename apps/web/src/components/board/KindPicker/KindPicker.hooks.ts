import type { ComponentType } from 'react';
import {
  BoltIcon,
  BuildIcon,
  DecomposeIcon,
  ResearchIcon,
} from '@/components/ui';
import type { TaskKind } from '@/lib/bridge';

type IconComponent = ComponentType<{ size?: number }>;

/** The icon component rendered beside each kind option (lucide set). The shell
 *  renders it — keeping JSX out of the `.hooks.ts` data module. */
export function kindIcon(kind: TaskKind): IconComponent {
  switch (kind) {
    case 'build':
      return BuildIcon;
    case 'research':
      return ResearchIcon;
    case 'decompose':
      return DecomposeIcon;
    case 'review':
      return BoltIcon;
  }
}
