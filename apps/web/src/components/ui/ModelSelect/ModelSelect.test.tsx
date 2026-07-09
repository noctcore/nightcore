import { composeStories } from '@storybook/react-vite';
import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ModelDescriptor } from '@nightcore/contracts';

import { ModelSelect } from './ModelSelect';
import { STATIC_MODEL_CATALOG_DATA, useModelCatalog } from './ModelSelect.hooks';
import * as stories from './ModelSelect.stories';
import type { ModelCatalogData, ModelCatalogState } from './ModelSelect.types';

const { Default, Loading, ErrorState, MultiProvider } = composeStories(stories);

/** The static catalog, as a `ready` state, for the fresh-render interaction tests. */
const STATIC_MODELS: ModelDescriptor[] =
  STATIC_MODEL_CATALOG_DATA.mode === 'sync' ? STATIC_MODEL_CATALOG_DATA.read() : [];
const READY: ModelCatalogState = { status: 'ready', models: STATIC_MODELS };

/** A codex model, used to build a catalog whose providers interleave. */
const CODEX_MODEL: ModelDescriptor = {
  value: 'gpt-5-codex',
  displayName: 'Codex GPT-5',
  description: 'OpenAI coding model',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high'],
};

const GPT_55: ModelDescriptor = {
  providerId: 'codex',
  value: 'gpt-5.5',
  displayName: 'GPT-5.5',
  description: 'Frontier model',
  supportsEffort: true,
  supportedEffortLevels: ['low', 'medium', 'high', 'xhigh'],
};

/** A catalog whose providers are interleaved in source order (Claude → Codex →
 *  Claude…), so the grouped display order differs from catalog-iteration order —
 *  the case that desyncs a naive source-order keyboard-nav index. Splicing the
 *  Codex model between the first two Claude models does it. */
const INTERLEAVED: ModelCatalogState = {
  status: 'ready',
  models: STATIC_MODELS.flatMap((model, i) => (i === 1 ? [CODEX_MODEL, model] : [model])),
};

test('the combobox is collapsed until opened', async () => {
  const screen = render(<Default />);
  expect(screen.container.querySelector('[role="listbox"]')).toBeNull();
  await expect
    .element(screen.getByRole('combobox', { name: /model/i }))
    .toHaveAttribute('aria-expanded', 'false');
});

test('opening reveals the provider-grouped listbox', async () => {
  const screen = render(<Default />);
  await screen.getByRole('combobox', { name: /model/i }).click();
  await expect.element(screen.getByRole('listbox')).toBeInTheDocument();
  await expect.element(screen.getByRole('group', { name: 'Claude' })).toBeInTheDocument();
});

test('renders a group per provider for a multi-provider catalog', async () => {
  const screen = render(<MultiProvider />);
  await screen.getByRole('combobox', { name: /model/i }).click();
  await expect.element(screen.getByRole('group', { name: 'Claude' })).toBeInTheDocument();
  await expect.element(screen.getByRole('group', { name: 'Codex' })).toBeInTheDocument();
});

test('clicking a model fires onChange with the model in the value object', async () => {
  const onChange = vi.fn();
  const screen = render(
    <ModelSelect value={{ model: null, effort: null }} onChange={onChange} catalog={READY} />,
  );
  await screen.getByRole('combobox', { name: /model/i }).click();
  await screen.getByRole('option', { name: /sonnet/i }).click();
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'claude-sonnet-4-6', providerId: 'claude' }),
  );
});

test('switching to a model that cannot honor the pinned effort resets it to Inherit', async () => {
  const onChange = vi.fn();
  const screen = render(
    <ModelSelect
      value={{ model: 'claude-opus-4-8', effort: 'max', providerId: 'claude' }}
      onChange={onChange}
      catalog={READY}
    />,
  );
  await screen.getByRole('combobox', { name: /model/i }).click();
  await screen.getByRole('option', { name: /haiku/i }).click();
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'claude-haiku-4-5', effort: null }),
  );
});

test('switching between models that both support the effort leaves it untouched', async () => {
  const onChange = vi.fn();
  const screen = render(
    <ModelSelect
      value={{ model: 'claude-opus-4-8', effort: 'high', providerId: 'claude' }}
      onChange={onChange}
      catalog={READY}
    />,
  );
  await screen.getByRole('combobox', { name: /model/i }).click();
  await screen.getByRole('option', { name: /sonnet/i }).click();
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'claude-sonnet-4-6', effort: 'high' }),
  );
});

test('arrow-down + Enter picks the highlighted model with the keyboard', async () => {
  const onChange = vi.fn();
  const screen = render(
    <ModelSelect value={{ model: null, effort: null }} onChange={onChange} catalog={READY} />,
  );
  await screen.getByRole('combobox', { name: /model/i }).click();
  await userEvent.keyboard('{ArrowDown}{Enter}');
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-opus-4-8' }));
});

test('grouped keyboard-nav stays in sync across an interleaved provider boundary', async () => {
  const onChange = vi.fn();
  const screen = render(
    <ModelSelect value={{ model: null, effort: null }} onChange={onChange} catalog={INTERLEAVED} />,
  );
  const combobox = screen.getByRole('combobox', { name: /model/i });
  await combobox.click();
  // Inherit(0) → Opus(1) → Sonnet(2). The third flat row is a Claude model that
  // trails the interleaved Codex model in source order, so a source-order index
  // would point the highlight at the Codex row instead.
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');

  // Invariant: the visually-highlighted (aria-selected) option IS the option the
  // combobox's aria-activedescendant references — the desync bug splits them onto
  // different rows once a provider interleaves.
  const active = screen.container.querySelector('[role="option"][aria-selected="true"]');
  expect(active).not.toBeNull();
  expect(active?.id).toBe(combobox.element().getAttribute('aria-activedescendant'));
  expect(active?.getAttribute('aria-label')).toMatch(/sonnet/i);

  // …and Enter picks that same row, not the source-order neighbor.
  await userEvent.keyboard('{Enter}');
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'claude-sonnet-4-6', providerId: 'claude' }),
  );
});

test('Escape closes the listbox', async () => {
  const screen = render(
    <ModelSelect value={{ model: null, effort: null }} onChange={vi.fn()} catalog={READY} />,
  );
  await screen.getByRole('combobox', { name: /model/i }).click();
  await expect.element(screen.getByRole('listbox')).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  expect(screen.container.querySelector('[role="listbox"]')).toBeNull();
});

test('the effort row surfaces the premium levels for Opus + the adaptive hint', async () => {
  const screen = render(
    <ModelSelect
      value={{ model: 'claude-opus-4-8', effort: 'max' }}
      onChange={vi.fn()}
      catalog={READY}
    />,
  );
  const efforts = screen.getByRole('radiogroup', { name: /reasoning effort/i });
  await expect.element(efforts.getByRole('radio', { name: /^max$/i })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect.element(screen.getByText(/decides adaptively/i)).toBeInTheDocument();
});

test('the speed model does not offer the Max effort level', async () => {
  const screen = render(
    <ModelSelect
      value={{ model: 'claude-haiku-4-5', effort: 'low' }}
      onChange={vi.fn()}
      catalog={READY}
    />,
  );
  const efforts = screen.getByRole('radiogroup', { name: /reasoning effort/i });
  expect(efforts.getByRole('radio', { name: /^max$/i }).query()).toBeNull();
});

test('dynamic Codex models use descriptor-provided effort levels', async () => {
  const screen = render(
    <ModelSelect
      value={{ model: 'gpt-5.5', effort: null, providerId: 'codex' }}
      onChange={vi.fn()}
      catalog={{ status: 'ready', models: [GPT_55] }}
    />,
  );
  const efforts = screen.getByRole('radiogroup', { name: /reasoning effort/i });
  await expect.element(efforts.getByRole('radio', { name: /^extra high$/i })).toBeInTheDocument();
  expect(efforts.getByRole('radio', { name: /^max$/i }).query()).toBeNull();
});

test('switching to a dynamic Codex model preserves a supported xhigh effort', async () => {
  const onChange = vi.fn();
  const screen = render(
    <ModelSelect
      value={{ model: 'claude-opus-4-8', effort: 'xhigh', providerId: 'claude' }}
      onChange={onChange}
      catalog={{ status: 'ready', models: [...STATIC_MODELS, GPT_55] }}
    />,
  );
  await screen.getByRole('combobox', { name: /model/i }).click();
  await screen.getByRole('option', { name: /gpt-5\.5/i }).click();
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'gpt-5.5', effort: 'xhigh', providerId: 'codex' }),
  );
});

test('picking an effort keeps the current model in the value object', async () => {
  const onChange = vi.fn();
  const screen = render(
    <ModelSelect
      value={{ model: 'claude-sonnet-4-6', effort: null, providerId: 'claude' }}
      onChange={onChange}
      catalog={READY}
    />,
  );
  const efforts = screen.getByRole('radiogroup', { name: /reasoning effort/i });
  await efforts.getByRole('radio', { name: /^high$/i }).click();
  expect(onChange).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'claude-sonnet-4-6', effort: 'high' }),
  );
});

test('a disabled control is disabled and stays collapsed', async () => {
  const screen = render(
    <ModelSelect
      value={{ model: 'claude-haiku-4-5', effort: null }}
      onChange={vi.fn()}
      catalog={READY}
      disabled
    />,
  );
  await expect.element(screen.getByRole('combobox', { name: /model/i })).toBeDisabled();
  expect(screen.container.querySelector('[role="listbox"]')).toBeNull();
});

test('the loading state shows a status region, not the combobox', async () => {
  const screen = render(<Loading />);
  await expect.element(screen.getByRole('status', { name: 'Loading models' })).toBeInTheDocument();
  expect(screen.container.querySelector('[role="combobox"]')).toBeNull();
});

test('the error state shows the message and a working retry', async () => {
  const retry = vi.fn();
  const catalog: ModelCatalogState = { status: 'error', message: 'no models', retry };
  const screen = render(
    <ModelSelect value={{ model: null, effort: null }} onChange={vi.fn()} catalog={catalog} />,
  );
  await expect.element(screen.getByText('no models')).toBeInTheDocument();
  await screen.getByRole('button', { name: /retry/i }).click();
  expect(retry).toHaveBeenCalled();
});

test('the error story renders the soft error + retry', async () => {
  const screen = render(<ErrorState />);
  await expect.element(screen.getByText('No models available')).toBeInTheDocument();
  await expect.element(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
});

// --- useModelCatalog seam ----------------------------------------------------

/** Probe that surfaces the catalog hook's state as queryable text. */
function CatalogProbe({ data }: { data: ModelCatalogData }) {
  const state = useModelCatalog(data);
  return (
    <div>
      <span>{`status:${state.status}`}</span>
      {state.status === 'ready' && <span>{`count:${state.models.length}`}</span>}
      {state.status === 'error' && (
        <>
          <span>{`err:${state.message}`}</span>
          {state.retry !== undefined && (
            <button type="button" onClick={state.retry}>
              retry
            </button>
          )}
        </>
      )}
    </div>
  );
}

test('the static (sync) seam resolves to ready immediately', async () => {
  const screen = render(<CatalogProbe data={STATIC_MODEL_CATALOG_DATA} />);
  await expect.element(screen.getByText(/status:ready/)).toBeInTheDocument();
  await expect.element(screen.getByText(/count:3/)).toBeInTheDocument();
});

test('the async seam transitions loading → ready', async () => {
  let resolveLoad: (models: ModelDescriptor[]) => void = () => {};
  const pending = new Promise<ModelDescriptor[]>((resolve) => {
    resolveLoad = resolve;
  });
  const data: ModelCatalogData = { mode: 'async', load: () => pending };
  const screen = render(<CatalogProbe data={data} />);
  await expect.element(screen.getByText(/status:loading/)).toBeInTheDocument();
  resolveLoad(STATIC_MODELS);
  await expect.element(screen.getByText(/status:ready/)).toBeInTheDocument();
});

test('the async seam surfaces an error and recovers on retry', async () => {
  let attempts = 0;
  const data: ModelCatalogData = {
    mode: 'async',
    load: () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('catalog down'))
        : Promise.resolve(STATIC_MODELS);
    },
  };
  const screen = render(<CatalogProbe data={data} />);
  await expect.element(screen.getByText('err:catalog down')).toBeInTheDocument();
  await screen.getByRole('button', { name: 'retry' }).click();
  await expect.element(screen.getByText(/status:ready/)).toBeInTheDocument();
});
