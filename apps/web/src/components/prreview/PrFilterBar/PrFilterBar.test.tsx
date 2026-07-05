import { userEvent } from '@vitest/browser/context';
import { useState } from 'react';
import { expect, test } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ReviewLifecycleState } from '../prreview-lifecycle';
import { PrFilterBar } from './PrFilterBar';
import type { PrSortOption } from './PrFilterBar.types';

/** A stateful harness so the multi-selects/sort actually reflect interactions
 *  (the picker owns this state in the app). */
function Harness() {
  const [selectedAuthors, setSelectedAuthors] = useState<readonly string[]>([]);
  const [selectedStatuses, setSelectedStatuses] = useState<readonly ReviewLifecycleState[]>([]);
  const [sort, setSort] = useState<PrSortOption>('newest');
  const hasActiveFilters =
    selectedAuthors.length > 0 || selectedStatuses.length > 0 || sort !== 'newest';
  return (
    <PrFilterBar
      authors={['alice', 'bob', 'carol']}
      selectedAuthors={selectedAuthors}
      onAuthorsChange={setSelectedAuthors}
      selectedStatuses={selectedStatuses}
      onStatusesChange={setSelectedStatuses}
      sort={sort}
      onSortChange={setSort}
      hasActiveFilters={hasActiveFilters}
      onReset={() => {
        setSelectedAuthors([]);
        setSelectedStatuses([]);
        setSort('newest');
      }}
    />
  );
}

test('opening the author dropdown and picking an author selects it', async () => {
  const screen = render(<Harness />);
  await screen.getByRole('button', { name: /author/i }).click();
  const option = screen.getByRole('option', { name: /alice/i });
  await expect.element(option).toHaveAttribute('aria-selected', 'false');
  await option.click();
  await expect.element(option).toHaveAttribute('aria-selected', 'true');
  // The trigger now carries a selected-count badge (1).
  await expect.element(screen.getByRole('button', { name: /author/i })).toHaveTextContent('1');
});

test('the author search narrows the visible options', async () => {
  const screen = render(<Harness />);
  await screen.getByRole('button', { name: /author/i }).click();
  await screen.getByRole('textbox', { name: /search authors/i }).fill('bo');
  await expect.element(screen.getByRole('option', { name: /bob/i })).toBeInTheDocument();
  await expect
    .element(screen.getByRole('option', { name: /alice/i }))
    .not.toBeInTheDocument();
});

test('keyboard: ArrowDown + Enter toggles the focused status option', async () => {
  const screen = render(<Harness />);
  await screen.getByRole('button', { name: /status/i }).click();
  // The listbox is focused on open; ArrowDown lands on the first option, Enter toggles.
  await userEvent.keyboard('{ArrowDown}{Enter}');
  await expect
    .element(screen.getByRole('option', { name: /reviewing/i }))
    .toHaveAttribute('aria-selected', 'true');
});

test('choosing a sort option updates the trigger and closes the menu', async () => {
  const screen = render(<Harness />);
  await screen.getByRole('button', { name: /newest/i }).click();
  await screen.getByRole('option', { name: /largest/i }).click();
  await expect.element(screen.getByRole('button', { name: /largest/i })).toBeInTheDocument();
  // Single-select closes on pick.
  expect(screen.container.querySelector('[role="listbox"]')).toBeNull();
});

test('roving keyboard focus exposes the active option via aria-activedescendant', async () => {
  const screen = render(<Harness />);
  await screen.getByRole('button', { name: /status/i }).click();
  const listbox = screen.container.querySelector('[role="listbox"]')!;
  // Nothing roving yet → no active descendant.
  expect(listbox.getAttribute('aria-activedescendant')).toBeNull();
  await userEvent.keyboard('{ArrowDown}');
  // The host now points at the focused option's own id (screen-reader visible).
  const active = listbox.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  const firstOption = screen.container.querySelectorAll('[role="option"]')[0]!;
  expect(firstOption.id).toBe(active);
});

test('closing a dropdown with Escape returns focus to its trigger', async () => {
  const screen = render(<Harness />);
  const trigger = screen.getByRole('button', { name: /status/i });
  await trigger.click();
  await userEvent.keyboard('{Escape}');
  // Focus must not drop to <body> — it returns to the trigger (WCAG 2.4.3).
  await expect.element(trigger).toHaveFocus();
});

test('picking a single-select sort option via keyboard returns focus to the trigger', async () => {
  const screen = render(<Harness />);
  await screen.getByRole('button', { name: /newest/i }).click();
  // Rove to the second option (Oldest) and activate — a single-select pick closes.
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}');
  await expect.element(screen.getByRole('button', { name: /oldest/i })).toHaveFocus();
});

test('reset-all appears once a filter is active and clears everything', async () => {
  const screen = render(<Harness />);
  // No reset while pristine.
  expect(screen.container.querySelector('button')?.textContent).not.toContain('Reset');
  await screen.getByRole('button', { name: /author/i }).click();
  await screen.getByRole('option', { name: /alice/i }).click();
  await userEvent.keyboard('{Escape}');
  const reset = screen.getByRole('button', { name: /reset/i });
  await expect.element(reset).toBeInTheDocument();
  await reset.click();
  await expect.element(screen.getByRole('button', { name: /reset/i })).not.toBeInTheDocument();
  // The author trigger no longer shows a count badge.
  await expect
    .element(screen.getByRole('button', { name: /author/i }))
    .not.toHaveTextContent('1');
});
