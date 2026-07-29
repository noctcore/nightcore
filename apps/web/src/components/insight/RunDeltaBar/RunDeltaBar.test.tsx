import { composeStories } from '@storybook/react-vite';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './RunDeltaBar.stories';

const { Default, ModelChanged, NoChange, FirstRun, NoComparableRun, RunNotDiffable } =
  composeStories(stories);

test('renders the three apparent counts against the previous run', async () => {
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/Apparent change vs previous run \(2h ago\)/))
    .toBeInTheDocument();
  await expect.element(screen.getByText('4 new')).toBeInTheDocument();
  await expect.element(screen.getByText('3 resolved')).toBeInTheDocument();
  await expect.element(screen.getByText('5 persisting')).toBeInTheDocument();
});

test('always shows the fingerprint caveat in visible text, not a tooltip', async () => {
  // The honesty is the feature: a reader of the counts must see, unprompted, that a
  // reworded finding double-counts. A hover-only disclosure would not do that.
  const screen = render(<Default />);
  await expect
    .element(screen.getByText(/Apparent, not verified/))
    .toBeInTheDocument();
  await expect
    .element(screen.getByText(/reworded between runs reads as one resolved plus one new/))
    .toBeInTheDocument();
});

test('discloses a model change on the compared-against run', async () => {
  const screen = render(<ModelChanged />);
  await expect
    .element(screen.getByText(/different model \(claude-sonnet-4-6\)/))
    .toBeInTheDocument();
});

test('renders explicit zeroes rather than hiding an unchanged run', async () => {
  const screen = render(<NoChange />);
  await expect.element(screen.getByText('0 new')).toBeInTheDocument();
  await expect.element(screen.getByText('0 resolved')).toBeInTheDocument();
  await expect.element(screen.getByText('12 persisting')).toBeInTheDocument();
});

test('says why there is no comparison instead of rendering nothing', async () => {
  const first = render(<FirstRun />);
  await expect.element(first.getByText(/No earlier analysis of this project/)).toBeInTheDocument();

  const none = render(<NoComparableRun />);
  await expect
    .element(none.getByText(/different scope, category set, or depth/))
    .toBeInTheDocument();

  const notDiffable = render(<RunNotDiffable />);
  await expect
    .element(notDiffable.getByText(/completed, whole-repo run of known depth/))
    .toBeInTheDocument();
});
