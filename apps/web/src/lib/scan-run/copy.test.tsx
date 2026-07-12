import { describe, expect, it, vi } from 'vitest';

import { formatRunReceipt } from '@/lib/formatters';

import {
  buildRunHistory,
  buildScanSummary,
  scanEmptyMessage,
  type ScanEmptyVerbs,
} from './copy';

describe('buildRunHistory', () => {
  const run = { id: 'r1', createdAt: 1_700_000_000_000, costUsd: 0.42, durationMs: 12_000 };

  it('formats each row as "<local time> · <count> · <receipt>" newest-first (caller order)', () => {
    const items = buildRunHistory([run], (r) => ({
      count: `${r.id === 'r1' ? 7 : 0} findings`,
      onSelect: () => {},
    }));
    expect(items).toHaveLength(1);
    expect(items[0]?.label).toBe(
      `${new Date(run.createdAt).toLocaleString()} · 7 findings · ${formatRunReceipt(
        run.costUsd,
        run.durationMs,
      )}`,
    );
  });

  it('wires each row onClick to that run’s onSelect', () => {
    const onSelect = vi.fn();
    const items = buildRunHistory([run], () => ({ count: '3 graded', onSelect }));
    items[0]?.onClick();
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('takes the count-noun verbatim from describe (findings / graded / conventions)', () => {
    for (const noun of ['5 findings', '5 graded', '5 conventions']) {
      const [item] = buildRunHistory([run], () => ({ count: noun, onSelect: () => {} }));
      expect(item?.label).toContain(` · ${noun} · `);
    }
  });

  it('maps an empty run list to an empty menu', () => {
    expect(buildRunHistory([], () => ({ count: 'x', onSelect: () => {} }))).toEqual([]);
  });
});

describe('buildScanSummary', () => {
  it('joins the parts with a middot behind the target glyph', () => {
    expect(buildScanSummary(['opus', 'high', 'repo', '3 categories'])).toBe(
      '⌖ opus · high · repo · 3 categories',
    );
  });

  it('handles a single part (no separator)', () => {
    expect(buildScanSummary(['default'])).toBe('⌖ default');
  });

  it('renders just the glyph for no parts', () => {
    expect(buildScanSummary([])).toBe('⌖ ');
  });
});

describe('scanEmptyMessage', () => {
  const verbs: ScanEmptyVerbs = {
    idle: 'Run an analysis to surface findings across your codebase.',
    running: 'Analyzing…',
    aborted: 'Analysis cancelled.',
    failed: 'Analysis failed',
    empty: 'No findings in this category — a clean bill of health.',
  };

  it('returns the idle prompt for an idle status', () => {
    expect(
      scanEmptyMessage({ status: 'idle', failureReason: null, error: null, verbs }),
    ).toBe(verbs.idle);
  });

  it('returns the running verb while the run is in flight', () => {
    expect(
      scanEmptyMessage({ status: 'running', failureReason: null, error: null, verbs }),
    ).toBe('Analyzing…');
  });

  it('returns the aborted copy when the failure reason is "aborted"', () => {
    expect(
      scanEmptyMessage({ status: 'failed', failureReason: 'aborted', error: null, verbs }),
    ).toBe('Analysis cancelled.');
  });

  it('appends the error to the failed prefix, or a bare period when there is none', () => {
    expect(
      scanEmptyMessage({ status: 'failed', failureReason: null, error: 'boom', verbs }),
    ).toBe('Analysis failed: boom.');
    expect(
      scanEmptyMessage({ status: 'failed', failureReason: null, error: null, verbs }),
    ).toBe('Analysis failed.');
  });

  it('the aborted branch wins over the error branch (both present)', () => {
    expect(
      scanEmptyMessage({ status: 'failed', failureReason: 'aborted', error: 'boom', verbs }),
    ).toBe('Analysis cancelled.');
  });

  it('returns the clean-bill copy for a completed run', () => {
    expect(
      scanEmptyMessage({ status: 'completed', failureReason: null, error: null, verbs }),
    ).toBe(verbs.empty);
  });

  it('tolerates an undefined failure reason (harness/insight streams)', () => {
    expect(
      scanEmptyMessage({ status: 'failed', failureReason: undefined, error: null, verbs }),
    ).toBe('Analysis failed.');
  });

  it('regression #228: a Harness-shaped cancelled scan gets the aborted copy (drift fixed)', () => {
    const harnessVerbs: ScanEmptyVerbs = {
      idle: 'Run a scan to surface the conventions across your codebase.',
      running: 'Scanning…',
      aborted: 'Scan cancelled.',
      failed: 'Scan failed',
      empty: 'No conventions in this lens.',
    };
    expect(
      scanEmptyMessage({
        status: 'failed',
        failureReason: 'aborted',
        error: null,
        verbs: harnessVerbs,
      }),
    ).toBe('Scan cancelled.');
  });

  it('PR-Review maps a null display stream to idle via `status ?? "idle"`', () => {
    // `as` keeps TS from narrowing the const to `never` so the `?.` idiom types.
    const displayStream = null as { status: string } | null;
    const prVerbs: ScanEmptyVerbs = {
      idle: 'Review this pull request to surface findings across the review lenses.',
      running: 'Reviewing…',
      aborted: 'Review cancelled.',
      failed: 'Review failed',
      empty: 'No findings — the diff looks clean across the selected lenses.',
    };
    expect(
      scanEmptyMessage({
        status: displayStream?.status ?? 'idle',
        failureReason: null,
        error: null,
        verbs: prVerbs,
      }),
    ).toBe(prVerbs.idle);
  });
});
