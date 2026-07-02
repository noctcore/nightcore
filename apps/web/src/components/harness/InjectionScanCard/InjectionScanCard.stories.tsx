import type { Meta, StoryObj } from '@storybook/react-vite';
import type { InjectionFlag } from '@/lib/bridge';
import { InjectionScanCard } from './InjectionScanCard';

/** Deterministic story/test flags (the same shape the Rust scan returns). */
export const STORY_FLAGS: InjectionFlag[] = [
  {
    path: 'docs/pasted-snippet.md',
    reasons: ['instruction-shaped phrase: "ignore previous instructions"'],
  },
  {
    path: 'vendor/readme.txt',
    reasons: [
      'invisible Unicode tag characters (hidden-prompt vector)',
      'zero-width character run (hidden-payload vector)',
    ],
  },
];

const meta = {
  title: 'Harness/InjectionScanCard',
  component: InjectionScanCard,
  args: {
    denyReadPaths: [],
    onQuarantine: () => {},
    scan: () => Promise.resolve(STORY_FLAGS),
  },
} satisfies Meta<typeof InjectionScanCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AlreadyQuarantined: Story = {
  args: { denyReadPaths: ['docs/pasted-snippet.md'] },
};

export const CleanRepo: Story = {
  args: { scan: () => Promise.resolve([]) },
};
