import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';

import type { ModelDescriptor } from '@nightcore/contracts';

import { ModelSelect } from './ModelSelect';
import { STATIC_MODEL_CATALOG_DATA, useModelCatalog } from './ModelSelect.hooks';
import type { ModelCatalogData, ModelCatalogState, ModelSelection } from './ModelSelect.types';

/** The static (curated) fallback catalog, in the `ready` state. */
const STATIC_MODELS: ModelDescriptor[] =
  STATIC_MODEL_CATALOG_DATA.mode === 'sync' ? STATIC_MODEL_CATALOG_DATA.read() : [];
const READY: ModelCatalogState = { status: 'ready', models: STATIC_MODELS };

/** A codex model, so the provider grouping is visible / interleavable. */
const CODEX_MODEL: ModelDescriptor = {
  value: 'gpt-5-codex',
  displayName: 'Codex GPT-5',
  description: 'OpenAI coding model',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high'],
};

/** A second provider (Codex) added so the provider grouping is visible. */
const MULTI_PROVIDER: ModelCatalogState = {
  status: 'ready',
  models: [...STATIC_MODELS, CODEX_MODEL],
};

/** A catalog whose providers interleave in source order (Claude → Codex → Claude…)
 *  rather than arriving pre-grouped — the shape a live `listModels()` can return.
 *  Exercises the grouped keyboard-nav invariant: the flat index the combobox walks
 *  must track each row's display position, or the highlight, aria-activedescendant,
 *  and Enter-target desync across the provider boundary. */
const INTERLEAVED: ModelCatalogState = {
  status: 'ready',
  models: STATIC_MODELS.flatMap((model, i) => (i === 1 ? [CODEX_MODEL, model] : [model])),
};

const meta = {
  title: 'UI/ModelSelect',
  component: ModelSelect,
  args: {
    value: { model: null, effort: null },
    onChange: fn(),
    catalog: READY,
  },
  decorators: [
    (Story) => (
      <div style={{ width: 460, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModelSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

/** Opening the combobox reveals the provider-grouped listbox. */
export const Open: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: /model/i }));
    await expect(canvas.getByRole('listbox')).toBeInTheDocument();
    await expect(canvas.getByRole('group', { name: 'Claude' })).toBeInTheDocument();
  },
};

/** With models from two providers, the listbox shows a group per provider. */
export const MultiProvider: Story = {
  args: { catalog: MULTI_PROVIDER },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: /model/i }));
    await expect(canvas.getByRole('group', { name: 'Claude' })).toBeInTheDocument();
    await expect(canvas.getByRole('group', { name: 'Codex' })).toBeInTheDocument();
  },
};

/** Interleaved providers: arrow-navigating past the group boundary keeps the
 *  highlighted (aria-selected) row, the aria-activedescendant, and the Enter-target
 *  on the same option. Regression cover for the source-order vs grouped-order index
 *  desync. */
export const InterleavedProviders: Story = {
  args: { catalog: INTERLEAVED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const combobox = canvas.getByRole('combobox', { name: /model/i });
    await userEvent.click(combobox);
    // Inherit(0) → Opus(1) → Sonnet(2): the third flat row trails the interleaved
    // Codex model in source order.
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    const active = canvasElement.querySelector('[role="option"][aria-selected="true"]');
    expect(active).not.toBeNull();
    expect(active?.id).toBe(combobox.getAttribute('aria-activedescendant'));
    expect(active?.getAttribute('aria-label')).toMatch(/sonnet/i);
  },
};

/** Opus is the premium tier — it unlocks the higher effort levels (Extra high /
 *  Max) and shows the adaptive-reasoning hint. */
export const OpusSelected: Story = {
  args: { value: { model: 'claude-opus-5-5', effort: 'high', providerId: 'claude' } },
};

/** The async seam is still resolving. */
export const Loading: Story = {
  args: { catalog: { status: 'loading' } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('status', { name: 'Loading models' })).toBeInTheDocument();
  },
};

/** The whole catalog read failed — a soft error with a retry affordance. */
export const ErrorState: Story = {
  args: { catalog: { status: 'error', message: 'No models available', retry: fn() } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('No models available')).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  },
};

export const Disabled: Story = {
  args: { value: { model: 'claude-haiku-4-5', effort: null }, disabled: true },
};

/** Play test: picking a model fires onChange with the model in the value object. */
export const PicksModel: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: /model/i }));
    await userEvent.click(canvas.getByRole('option', { name: /sonnet/i }));
    await expect(args.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-5' }),
    );
  },
};

/** Play test: picking an effort level fires onChange, keeping the model. */
export const PicksEffort: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const efforts = within(canvas.getByRole('radiogroup', { name: /reasoning effort/i }));
    await userEvent.click(efforts.getByRole('radio', { name: /^high$/i }));
    await expect(args.onChange).toHaveBeenCalledWith(expect.objectContaining({ effort: 'high' }));
  },
};

/** Play test: switching from Opus (effort=max) to Haiku — which can't honor `max` —
 *  reconciles the pinned effort back to Inherit (max → null). */
export const ReconcilesEffortOnModelSwitch: Story = {
  args: { value: { model: 'claude-opus-5-5', effort: 'max', providerId: 'claude' } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('combobox', { name: /model/i }));
    await userEvent.click(canvas.getByRole('option', { name: /haiku/i }));
    await expect(args.onChange).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-haiku-4-5', effort: null }),
    );
  },
};

/** A stable, module-scope async seam — the shape a real parent would pass (a
 *  module const or a memoized value), so the hook fetches once. */
const LIVE_SEAM: ModelCatalogData = {
  mode: 'async',
  load: () => Promise.resolve(STATIC_MODELS),
};

/** Demonstrates the live wiring: a parent calls {@link useModelCatalog} with an
 *  async seam and hands the resolved state to ModelSelect. */
function ModelSelectLive() {
  const [selection, setSelection] = useState<ModelSelection>({ model: null, effort: null });
  const catalog = useModelCatalog(LIVE_SEAM);
  return <ModelSelect value={selection} onChange={setSelection} catalog={catalog} />;
}

export const LiveWiring: Story = {
  render: () => <ModelSelectLive />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('combobox', { name: /model/i })).toBeInTheDocument();
  },
};
