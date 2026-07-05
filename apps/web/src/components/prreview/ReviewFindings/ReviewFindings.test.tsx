import { expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-react';

import type { ReviewFindingView } from '../prreview.types';
import { ReviewFindings } from './ReviewFindings';
import type { ReviewFindingsProps } from './ReviewFindings.types';

function finding(over: Partial<ReviewFindingView> = {}): ReviewFindingView {
  return {
    id: 'f1',
    lens: 'logic',
    severity: 'high',
    file: 'src/a.ts',
    line: 12,
    title: 'A finding',
    body: 'Some detail about the finding.',
    suggestedFix: null,
    fingerprint: 'fp1',
    corroboratedBy: [],
    status: 'open',
    linkedTaskId: null,
    ...over,
  };
}

/** The standard mixed-severity set: critical + high open by default, medium +
 *  low collapsed. f1 is corroborated by two other lenses. */
function standardFindings(): ReviewFindingView[] {
  return [
    finding({
      id: 'f1',
      severity: 'critical',
      lens: 'security',
      title: 'Secret in log line',
      corroboratedBy: ['logic', 'tests'],
    }),
    finding({ id: 'f2', severity: 'high', lens: 'logic', title: 'Unawaited promise', line: 12 }),
    finding({ id: 'm1', severity: 'medium', lens: 'structure', title: 'Med A' }),
    finding({ id: 'm2', severity: 'medium', lens: 'structure', title: 'Med B' }),
    finding({ id: 'l1', severity: 'low', lens: 'tests', title: 'Missing edge-case test' }),
  ];
}

function renderFindings(over: Partial<ReviewFindingsProps> = {}) {
  const props: ReviewFindingsProps = {
    findings: standardFindings(),
    emptyMessage: 'Review a pull request to surface findings across lenses.',
    selection: new Set<string>(),
    onToggleSelect: vi.fn(),
    onSelectionChange: vi.fn(),
    onOpen: vi.fn(),
    ...over,
  };
  return { ...render(<ReviewFindings {...props} />), props };
}

/** The Set argument of the Nth `onSelectionChange` call, sorted for comparison. */
function nthSelection(fn: ReviewFindingsProps['onSelectionChange'], n = 0): string[] {
  const call = (fn as unknown as { mock: { calls: [ReadonlySet<string>][] } }).mock
    .calls[n];
  return [...(call?.[0] ?? new Set<string>())].sort();
}

test('renders the severity group headers and a grounded location', async () => {
  const screen = renderFindings();
  // Each non-empty severity bucket has a collapse toggle (button) and a tri-state
  // group checkbox that names the severity.
  await expect
    .element(screen.getByRole('checkbox', { name: /select all open critical findings/i }))
    .toBeInTheDocument();
  await expect
    .element(screen.getByRole('checkbox', { name: /select all open high findings/i }))
    .toBeInTheDocument();
  // The grounded location renders as inert file:line text (f2, in the open High
  // group).
  await expect.element(screen.getByText('src/a.ts:12').first()).toBeInTheDocument();
});

test('collapses medium and low by default; expanding a group reveals its cards', async () => {
  const screen = renderFindings();
  // Critical/High are expanded → their cards render.
  await expect.element(screen.getByText('Secret in log line')).toBeInTheDocument();
  await expect.element(screen.getByText('Unawaited promise')).toBeInTheDocument();
  // Medium/Low are collapsed → their cards are absent from the DOM.
  await expect.element(screen.getByText('Med A')).not.toBeInTheDocument();
  await expect
    .element(screen.getByText('Missing edge-case test'))
    .not.toBeInTheDocument();

  // The Medium collapse toggle reports collapsed, and expands on click. Its
  // accessible name is the label + group count ("Medium 2") — distinct from the
  // cards' names (which also carry a "Medium" severity badge) once expanded.
  const medium = screen.getByRole('button', { name: 'Medium 2' });
  await expect.element(medium).toHaveAttribute('aria-expanded', 'false');
  await medium.click();
  await expect.element(screen.getByText('Med A')).toBeInTheDocument();
  await expect.element(medium).toHaveAttribute('aria-expanded', 'true');
});

test('a corroborated finding shows a compact "also:" chip', async () => {
  const screen = renderFindings();
  await expect.element(screen.getByText('also: logic, tests')).toBeInTheDocument();
});

test('quick-select All selects every OPEN finding', async () => {
  const { getByRole, props } = renderFindings();
  await getByRole('button', { name: /^all$/i }).click();
  expect(props.onSelectionChange).toHaveBeenCalledTimes(1);
  expect(nthSelection(props.onSelectionChange)).toEqual(['f1', 'f2', 'l1', 'm1', 'm2']);
});

test('quick-select Critical + High selects only those tiers', async () => {
  const { getByRole, props } = renderFindings();
  await getByRole('button', { name: /critical \+ high/i }).click();
  expect(nthSelection(props.onSelectionChange)).toEqual(['f1', 'f2']);
});

test('quick-select None clears the whole selection', async () => {
  const { getByRole, props } = renderFindings({ selection: new Set(['f1', 'f2']) });
  await getByRole('button', { name: /^none$/i }).click();
  expect(nthSelection(props.onSelectionChange)).toEqual([]);
});

test('quick-select ops exclude dismissed findings', async () => {
  const { getByRole, props } = renderFindings({
    findings: [
      finding({ id: 'open1', severity: 'high', status: 'open' }),
      finding({ id: 'gone', severity: 'high', status: 'dismissed' }),
    ],
  });
  await getByRole('button', { name: /^all$/i }).click();
  // The dismissed finding never joins a bulk op — only the open one is selected.
  expect(nthSelection(props.onSelectionChange)).toEqual(['open1']);
});

test('a group checkbox is indeterminate when only some open findings are selected', async () => {
  // Two open medium findings, one selected → the Medium group is tri-state mixed.
  const screen = renderFindings({ selection: new Set(['m1']) });
  const medium = screen.getByRole('checkbox', { name: /select all open medium findings/i });
  await expect.element(medium).toHaveAttribute('aria-checked', 'mixed');
});

test('a fully-selected group checkbox reports checked and toggles the group off', async () => {
  const { getByRole, props } = renderFindings({ selection: new Set(['m1', 'm2']) });
  const medium = getByRole('checkbox', { name: /select all open medium findings/i });
  await expect.element(medium).toHaveAttribute('aria-checked', 'true');
  // Checked → clicking deselects the group's open findings (leaving others).
  await medium.click();
  expect(nthSelection(props.onSelectionChange)).toEqual([]);
});

test('toggling a group checkbox from empty selects that group’s open findings', async () => {
  const { getByRole, props } = renderFindings({ selection: new Set(['f1']) });
  // High group has one open finding (f2), unselected → clicking adds it, keeping
  // the existing selection.
  await getByRole('checkbox', { name: /select all open high findings/i }).click();
  expect(nthSelection(props.onSelectionChange)).toEqual(['f1', 'f2']);
});

test('toggling a card checkbox fires the single-finding selection handler', async () => {
  const { getByText, props } = renderFindings();
  await getByText('Include in review').first().click();
  expect(props.onToggleSelect).toHaveBeenCalledTimes(1);
});

test('shows the empty message when there are no findings', async () => {
  const screen = renderFindings({ findings: [] });
  await expect
    .element(screen.getByText(/review a pull request to surface findings/i))
    .toBeInTheDocument();
});

test('a completed clean run shows the celebratory positive empty state', async () => {
  const screen = renderFindings({
    findings: [],
    emptyVariant: 'clean',
    emptyMessage: 'No findings — the diff looks clean across the selected lenses.',
  });
  // The success-toned "No findings" heading, distinct from the neutral message.
  await expect
    .element(screen.getByText('No findings', { exact: true }))
    .toBeInTheDocument();
  await expect.element(screen.getByText(/the diff looks clean/i)).toBeInTheDocument();
});

test('a fully-triaged grid shows the all-triaged banner and no quick-select row', async () => {
  const screen = renderFindings({
    findings: [
      finding({ id: 'c1', severity: 'high', status: 'converted', title: 'Converted one' }),
      finding({ id: 'd1', severity: 'high', status: 'dismissed', title: 'Dismissed one' }),
    ],
  });
  await expect.element(screen.getByText(/all findings triaged/i)).toBeInTheDocument();
  // Nothing open → no "All" quick-select preset.
  await expect
    .element(screen.getByRole('button', { name: /^all$/i }))
    .not.toBeInTheDocument();
});
