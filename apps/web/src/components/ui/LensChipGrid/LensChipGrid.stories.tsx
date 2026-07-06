import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { BugIcon, LayersIcon, LockIcon, PerfIcon } from '../icons';
import { ScanConfigForm } from './LensChipGrid';
import type { ScanConfigFormProps } from './LensChipGrid.types';

type LensKey = 'architecture' | 'bugs' | 'performance' | 'security';

const CHIPS = [
  { key: 'architecture' as LensKey, label: 'Architecture', icon: LayersIcon },
  { key: 'bugs' as LensKey, label: 'Bugs', icon: BugIcon },
  { key: 'performance' as LensKey, label: 'Performance', icon: PerfIcon },
  { key: 'security' as LensKey, label: 'Security', icon: LockIcon },
];

/** Concrete wrapper so Storybook's arg inference sees a non-generic component. */
function StoryScanConfigForm(props: ScanConfigFormProps<LensKey>) {
  return <ScanConfigForm {...props} />;
}

const meta = {
  title: 'UI/LensChipGrid',
  component: StoryScanConfigForm,
  args: {
    heading: 'Categories (2/4)',
    chips: CHIPS,
    selected: new Set<LensKey>(['bugs', 'security']),
    onToggle: fn(),
    onSelectAll: fn(),
    onSelectNone: fn(),
    model: null,
    effort: null,
    onChangeModel: fn(),
    onChangeEffort: fn(),
    canRun: true,
    isStarting: false,
    onRun: fn(),
    ctaIcon: <BugIcon size={15} />,
    ctaLabel: 'Analyze',
    hint: 'Scans the whole repo across 2 lenses · cost depends on repo size.',
  },
} satisfies Meta<typeof StoryScanConfigForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** The busy CTA while the optimistic start is in flight. */
export const Starting: Story = {
  args: { isStarting: true },
};

/** Nothing selected → the CTA is disabled. */
export const NoneSelected: Story = {
  args: {
    selected: new Set<LensKey>(),
    heading: 'Categories (0/4)',
    canRun: false,
  },
};
