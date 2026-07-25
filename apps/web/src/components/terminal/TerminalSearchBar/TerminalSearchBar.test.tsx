import { userEvent } from '@vitest/browser/context';
import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import { TerminalSearchBar } from './TerminalSearchBar';

function setup(over: Partial<Parameters<typeof TerminalSearchBar>[0]> = {}) {
  const props = {
    query: 'ls',
    noMatch: false,
    resultIndex: 0,
    resultCount: 3,
    onQueryChange: vi.fn(),
    onNext: vi.fn(),
    onPrev: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  const screen = render(<TerminalSearchBar {...props} />);
  return { screen, props };
}

test('typing in the field re-runs the search', async () => {
  const { screen, props } = setup({ query: '' });
  const input = screen.getByLabelText('Search terminal scrollback');
  await userEvent.type(input, 'x');
  expect(props.onQueryChange).toHaveBeenCalledWith('x');
});

test('Enter steps to the next match, Shift+Enter to the previous', async () => {
  const { screen, props } = setup();
  const input = screen.getByLabelText('Search terminal scrollback');
  await userEvent.click(input);
  await userEvent.keyboard('{Enter}');
  expect(props.onNext).toHaveBeenCalledTimes(1);
  await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
  expect(props.onPrev).toHaveBeenCalledTimes(1);
});

test('Escape and the × button close the bar', async () => {
  const { screen, props } = setup();
  const input = screen.getByLabelText('Search terminal scrollback');
  await userEvent.click(input);
  await userEvent.keyboard('{Escape}');
  expect(props.onClose).toHaveBeenCalledTimes(1);

  await userEvent.click(screen.getByLabelText('Close search (Esc)'));
  expect(props.onClose).toHaveBeenCalledTimes(2);
});

test('the ‹ › buttons step matches', async () => {
  const { screen, props } = setup();
  await userEvent.click(screen.getByLabelText('Previous match (Shift+Enter)'));
  expect(props.onPrev).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByLabelText('Next match (Enter)'));
  expect(props.onNext).toHaveBeenCalledTimes(1);
});

test('a no-match query flags the input as invalid-styled', () => {
  const { screen } = setup({ query: 'nope', noMatch: true });
  const input = screen.getByLabelText('Search terminal scrollback');
  expect(input.element().className).toContain('text-destructive');
});

test('shows a 1-based n/m match counter for the active query', async () => {
  const { screen } = setup({ query: 'ls', resultIndex: 1, resultCount: 5 });
  await expect.element(screen.getByText('2/5')).toBeInTheDocument();
});

test('hides the counter when the query is empty', () => {
  const { screen } = setup({ query: '', resultIndex: -1, resultCount: 0 });
  expect(screen.container.textContent).not.toContain('/');
});
