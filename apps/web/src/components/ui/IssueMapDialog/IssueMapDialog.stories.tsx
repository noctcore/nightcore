import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';

import { IssueMapDialog } from './IssueMapDialog';
import {
  DEGRADED_RESULT,
  makePreview,
  PARTIAL_RESULT,
  SUCCESS_RESULT,
} from './IssueMapDialog.fixtures';

/** Modal overlays portal to `document.body`. */
const surface = () => within(document.body);

const meta = {
  title: 'UI/IssueMapDialog',
  component: IssueMapDialog,
  parameters: { layout: 'fullscreen' },
  args: {
    open: true,
    scanKind: 'insight',
    runId: 'run-abc',
    onClose: fn(),
  },
} satisfies Meta<typeof IssueMapDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Insight preview: the parent body, group chips, and every sub-issue title. */
export const InsightPreview: Story = {
  args: { override: { preview: makePreview() } },
  play: async () => {
    const canvas = surface();
    await expect(
      canvas.getByText('Unhandled promise rejection in the sync worker'),
    ).toBeInTheDocument();
    await expect(canvas.getByText('Off-by-one in pagination bounds')).toBeInTheDocument();
    // The confirm is an explicit click — the button is present in preview state.
    await expect(
      canvas.getByRole('button', { name: /export to github/i }),
    ).toBeInTheDocument();
  },
};

/** Scorecard preview: grouped by dimension. */
export const ScorecardPreview: Story = {
  args: {
    scanKind: 'scorecard',
    override: {
      preview: makePreview({
        scanKind: 'scorecard',
        parentTitle: 'Nightcore Scorecard map — 4 readings',
        total: 4,
        subIssues: [
          { title: 'Observability — no structured logs on the worker', groupLabel: 'Observability' },
          { title: 'Security — unverified webhook handler', groupLabel: 'Security' },
          { title: 'Testing — the payments path is untested', groupLabel: 'Testing' },
          { title: 'Testing — no regression suite', groupLabel: 'Testing' },
        ],
        groups: [
          { label: 'Observability', count: 1 },
          { label: 'Security', count: 1 },
          { label: 'Testing', count: 2 },
        ],
      }),
    },
  },
};

/** Enforce preview: grouped by coverage status. */
export const EnforcePreview: Story = {
  args: {
    scanKind: 'enforce',
    override: {
      preview: makePreview({
        scanKind: 'enforce',
        parentTitle: 'Nightcore Enforce map — 3 conventions',
        total: 3,
        subIssues: [
          { title: 'Barrels must re-export every public symbol', groupLabel: 'unenforced' },
          { title: 'No cross-feature imports', groupLabel: 'documented-only' },
          { title: 'Folder-per-component structure', groupLabel: 'enforced' },
        ],
        groups: [
          { label: 'unenforced', count: 1 },
          { label: 'documented-only', count: 1 },
          { label: 'enforced', count: 1 },
        ],
      }),
    },
  },
};

/** A prior map exists — the supersede link + opt-in "close the old map" checkbox. */
export const SupersedePresent: Story = {
  args: {
    override: {
      preview: makePreview({
        supersedes: {
          number: 101,
          title: 'Nightcore Insight map — 9 findings',
          url: 'https://github.com/acme/widget/issues/101',
        },
      }),
    },
  },
  play: async () => {
    const canvas = surface();
    await expect(
      canvas.getByText(/Close the superseded map #101 and its open sub-issues/i),
    ).toBeInTheDocument();
  },
};

/** Above ~50 sub-issues — the soft warning banner (no hard cap). */
export const OverFiftyWarning: Story = {
  args: {
    override: {
      preview: makePreview({
        total: 63,
        softWarning: 'This will open 64 issues (63 sub-issues + 1 parent) on GitHub.',
      }),
    },
  },
  play: async () => {
    const canvas = surface();
    await expect(canvas.getByText(/This will open 64 issues/i)).toBeInTheDocument();
  },
};

/** The LLM narrative fell open to a deterministic template — a subtle note. */
export const FailOpenNarrative: Story = {
  args: { override: { preview: makePreview({ narrativeOk: false }) } },
};

/** In-flight: the confirm button shows the `Creating… k/N` progress. */
export const Exporting: Story = {
  args: {
    override: { preview: makePreview(), submitting: true, progress: { created: 2, total: 6 } },
  },
  play: async () => {
    const canvas = surface();
    await expect(canvas.getByText(/Creating… 2\/6/i)).toBeInTheDocument();
  },
};

/** Terminal — full success: the parent link. */
export const Success: Story = {
  args: { override: { result: SUCCESS_RESULT } },
  play: async () => {
    const canvas = surface();
    await expect(canvas.getByText(/Exported map with 6 sub-issues/i)).toBeInTheDocument();
    await expect(canvas.getByRole('button', { name: 'Done' })).toBeInTheDocument();
  },
};

/** Terminal — PARTIAL: created k of N; nothing deleted. */
export const Partial: Story = {
  args: { override: { result: PARTIAL_RESULT } },
  play: async () => {
    const canvas = surface();
    await expect(
      canvas.getByText(/Partial export — created 3 of 6 sub-issues/i),
    ).toBeInTheDocument();
    await expect(canvas.getByText(/Nothing was deleted/i)).toBeInTheDocument();
  },
};

/** Terminal — DEGRADED linkage: all created, task-list linked. */
export const DegradedLinkage: Story = {
  args: { override: { result: DEGRADED_RESULT } },
  play: async () => {
    const canvas = surface();
    await expect(canvas.getByText(/task-list linkage/i)).toBeInTheDocument();
  },
};

/** Terminal — a hard rejection (the parent never landed). */
export const HardError: Story = {
  args: { override: { exportError: 'gh: authentication required' } },
  play: async () => {
    const canvas = surface();
    await expect(canvas.getByText('gh: authentication required')).toBeInTheDocument();
  },
};

/** The preview fetch failed (bad run / no gh). */
export const LoadError: Story = {
  args: { override: { loadError: 'this run has no exportable findings' } },
  play: async () => {
    const canvas = surface();
    await expect(
      canvas.getByText('this run has no exportable findings'),
    ).toBeInTheDocument();
  },
};

/** Pressing Enter must NOT confirm the irreversible write: the Modal wires no
 *  `onEnter`, so Enter never fires the export — the dialog stays in preview state
 *  and never reaches a terminal (Done) banner. */
export const EnterDoesNotConfirm: Story = {
  args: { override: { preview: makePreview() } },
  play: async () => {
    const canvas = surface();
    await expect(
      canvas.getByRole('button', { name: /export to github/i }),
    ).toBeInTheDocument();
    await userEvent.keyboard('{Enter}');
    // Still in preview — Enter produced no terminal export state.
    await expect(
      canvas.getByRole('button', { name: /export to github/i }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  },
};
