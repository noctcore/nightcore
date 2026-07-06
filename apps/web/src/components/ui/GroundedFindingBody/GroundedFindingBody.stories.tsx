import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { DetailSection } from '../DetailPanelShell';
import {
  GroundedFindingBody,
  GroundedLifecycleFooter,
} from './GroundedFindingBody';
import type {
  GroundedFindingBodyProps,
  GroundedFindingView,
} from './GroundedFindingBody.types';

/** The story item: a minimal grounded finding a scan family would render. */
interface StoryFinding {
  id: string;
  title: string;
  status: 'open' | 'dismissed' | 'converted';
}

/** Concrete wrapper so Storybook's arg inference sees a non-generic component. */
function StoryFindingBody(props: GroundedFindingBodyProps<StoryFinding>) {
  return <GroundedFindingBody {...props} />;
}

const FINDING: StoryFinding = {
  id: 'f1',
  title: 'Unawaited promise drops errors',
  status: 'open',
};

function renderFinding(shown: StoryFinding): GroundedFindingView {
  return {
    title: shown.title,
    badges: (
      <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        High
      </span>
    ),
    footer: (
      <GroundedLifecycleFooter
        status={shown.status}
        pending={false}
        onConvert={fn()}
        onDismiss={fn()}
        onRestore={fn()}
        onGotoBoard={fn()}
      />
    ),
    sections: {
      description: 'A fire-and-forget `void` call swallows rejections.',
      location: 'src/app/tasks.ts:42',
      rationale: 'Failures vanish without a toast or a log line.',
      suggestion: 'Await the call inside the existing runAction wrapper.',
      codeBefore: 'void save(task);',
      codeAfter: 'await runAction(() => save(task));',
      language: 'ts',
      affectedFiles: ['src/app/tasks.ts'],
      tags: ['async', 'error-handling'],
    },
  };
}

const meta = {
  title: 'UI/GroundedFindingBody',
  component: StoryFindingBody,
  args: {
    open: true,
    item: FINDING,
    onClose: fn(),
    render: renderFinding,
  },
} satisfies Meta<typeof StoryFindingBody>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Inert (model-authored) description + extra family section slots. */
export const InertWithExtraSections: Story = {
  args: {
    render: (shown: StoryFinding): GroundedFindingView => ({
      ...renderFinding(shown),
      sections: {
        description: 'Model-authored body rendered as inert text.',
        descriptionInert: true,
        afterDescription: (
          <DetailSection title="Corroboration">
            <p className="text-[13px] text-muted-foreground">
              Also surfaced by the Security lens.
            </p>
          </DetailSection>
        ),
        location: 'src/app/tasks.ts:42',
        suggestion: 'const fixed = true;',
        suggestionCode: true,
        extra: (
          <DetailSection title="Evidence">
            <p className="text-[13px] text-muted-foreground">
              Two call sites drop the rejection.
            </p>
          </DetailSection>
        ),
      },
    }),
  },
};

/** A dismissed item shows the Restore action in the shared footer. */
export const Dismissed: Story = {
  args: {
    item: { ...FINDING, status: 'dismissed' },
  },
};
