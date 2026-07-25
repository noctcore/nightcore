import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';

import { TerminalSearchBar } from './TerminalSearchBar';

const meta = {
  title: 'Terminal/TerminalSearchBar',
  component: TerminalSearchBar,
  args: {
    query: 'error',
    noMatch: false,
    resultIndex: 0,
    resultCount: 4,
    onQueryChange: fn(),
    onNext: fn(),
    onPrev: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof TerminalSearchBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A find bar with an active query that has matches. */
export const Default: Story = {};

/** A query that matched nothing — the no-results style. */
export const NoMatch: Story = {
  args: { query: 'zzzznotfound', noMatch: true, resultIndex: -1, resultCount: 0 },
};

/** An empty query (just opened) — no counter shown. */
export const Empty: Story = {
  args: { query: '', resultIndex: -1, resultCount: 0 },
};
