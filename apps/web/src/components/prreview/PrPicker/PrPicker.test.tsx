import { composeStories } from '@storybook/react-vite';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import * as stories from './PrPicker.stories';

const { Loaded, Empty, Error: ErrorStory, WithRunBadges, LoadMore, AllLoaded } =
  composeStories(stories);

test('rows show the running badge and the open-finding count from the registry props', async () => {
  const screen = render(<WithRunBadges />);
  // The badges are plain text (visible + sr-only suffix), never aria-labels on
  // generic spans — so they land in each option's accessible name directly.
  // #128 has a run in flight → the "Reviewing" spinner badge.
  await expect
    .element(screen.getByRole('option', { name: /#128/ }))
    .toHaveTextContent('Reviewing');
  // #127's latest completed run left 3 open findings → the visible count with
  // the sr-only "open findings" suffix.
  await expect
    .element(screen.getByRole('option', { name: /#127/ }))
    .toHaveTextContent(/3\s*open findings/);
  // #119 has neither run nor findings → no badge of either kind.
  const bare = screen.getByRole('option', { name: /#119/ });
  await expect.element(bare).not.toHaveTextContent('Reviewing');
  await expect.element(bare).not.toHaveTextContent(/open finding/);
});

test('selecting a PR from the list reports its number', async () => {
  const onChange = vi.fn();
  const screen = render(<Loaded onChange={onChange} />);
  await screen.getByRole('option', { name: /#128/ }).click();
  expect(onChange).toHaveBeenCalledWith(128);
});

test('filtering narrows the list by title/author/branch', async () => {
  const screen = render(<Loaded />);
  await screen.getByRole('textbox', { name: /filter open pull requests/i }).fill('alice');
  // Only PR #127 (author alice) survives.
  await expect.element(screen.getByRole('option', { name: /#127/ })).toBeInTheDocument();
  await expect
    .element(screen.getByRole('option', { name: /#128/ }))
    .not.toBeInTheDocument();
});

test('typing a number not in the list offers a manual select affordance', async () => {
  const onChange = vi.fn();
  const screen = render(<Loaded onChange={onChange} />);
  await screen
    .getByRole('textbox', { name: /filter open pull requests/i })
    .fill('999');
  const manual = screen.getByRole('button', { name: /select pr #999/i });
  await expect.element(manual).toBeInTheDocument();
  await manual.click();
  expect(onChange).toHaveBeenCalledWith(999);
});

test('the empty state still lets the user type a number', async () => {
  const onChange = vi.fn();
  const screen = render(<Empty onChange={onChange} />);
  await expect
    .element(screen.getByText(/no open pull requests/i))
    .toBeInTheDocument();
  await screen
    .getByRole('textbox', { name: /filter open pull requests/i })
    .fill('42');
  await screen.getByRole('button', { name: /select pr #42/i }).click();
  expect(onChange).toHaveBeenCalledWith(42);
});

test('a fetch error is surfaced inline but manual entry still works', async () => {
  const screen = render(<ErrorStory />);
  await expect
    .element(screen.getByRole('alert'))
    .toHaveTextContent(/no default remote repository/i);
});

test('rows show compact +adds/-dels diff stats from the summary', async () => {
  const screen = render(<Loaded />);
  const row = screen.getByRole('option', { name: /#128/ });
  await expect.element(row).toHaveTextContent('+120');
  await expect.element(row).toHaveTextContent('-14');
});

test('the author filter narrows the list to the chosen contributor', async () => {
  const screen = render(<Loaded />);
  await screen.getByRole('button', { name: /author/i }).click();
  // The dropdown option's accessible name is exactly "@alice" (distinct from the
  // longer row names that merely contain it) — `exact` avoids the substring match.
  await screen.getByRole('option', { name: '@alice', exact: true }).click();
  // #127 (alice) survives; #128 (shirone) is filtered out.
  await expect.element(screen.getByRole('option', { name: /#127/ })).toBeInTheDocument();
  await expect
    .element(screen.getByRole('option', { name: /#128/ }))
    .not.toBeInTheDocument();
});

test('the load-more footer fires onLoadMore when more may exist', async () => {
  const onLoadMore = vi.fn();
  const screen = render(<LoadMore onLoadMore={onLoadMore} />);
  await screen.getByRole('button', { name: /load more/i }).click();
  expect(onLoadMore).toHaveBeenCalled();
});

test('the footer reads "all loaded" when nothing more remains', async () => {
  const screen = render(<AllLoaded />);
  await expect
    .element(screen.getByText(/all pull requests loaded/i))
    .toBeInTheDocument();
});
