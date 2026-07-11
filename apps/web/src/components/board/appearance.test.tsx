import { describe, expect, it } from 'vitest';

import type { BoardAppearance, Settings } from '@/lib/bridge';

import {
  appearanceView,
  clampOpacity,
  DEFAULT_APPEARANCE,
  isDefaultAppearance,
  resolveAppearance,
} from './appearance';

/** A Settings shell carrying one project override's appearance. */
function settingsWith(projectId: string, appearance: BoardAppearance): Settings {
  return {
    defaultModel: 'claude-opus-4-8',
    defaultEffort: 'medium',
    maxConcurrency: 3,
    permissionMode: 'bypass',
    provider: 'claude',
    cleanupWorktrees: true,
    notifyOnComplete: false,
    defaultRunMode: 'main',
    maxTurns: null,
    maxBudgetUsd: null,
    mcpServers: [],
    contextPackEnabled: true,
    autoCommitOnVerified: false,
    sandboxSessions: false,
    issueSyncEnabled: false,
    sidebarStyle: 'unified',
    preferredEditor: null,
    terminalWebglEnabled: false,
    terminalConfinedDefault: false,
    terminalFontSize: null,
    terminalScrollback: null,
    usageMeterEnabled: false,
    autoPauseUsageThreshold: 90,
    terminalYoloLaunch: false,
    terminalDaemonEnabled: false,
    terminalAiNaming: false,
    projectOverrides: { [projectId]: { boardAppearance: appearance } },
  };
}

describe('clampOpacity', () => {
  it('clamps into [0,1] and fails safe to 1 on non-finite', () => {
    expect(clampOpacity(0.5)).toBe(0.5);
    expect(clampOpacity(-2)).toBe(0);
    expect(clampOpacity(9)).toBe(1);
    expect(clampOpacity(Number.NaN)).toBe(1);
    expect(clampOpacity(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('resolveAppearance', () => {
  it('returns the defaults when settings or project is absent', () => {
    expect(resolveAppearance(null, 'p1')).toEqual(DEFAULT_APPEARANCE);
    expect(resolveAppearance(settingsWith('p1', DEFAULT_APPEARANCE), null)).toEqual(
      DEFAULT_APPEARANCE,
    );
  });

  it('returns the defaults for a project with no override', () => {
    const s = settingsWith('p1', { ...DEFAULT_APPEARANCE, cardOpacity: 0.4 });
    expect(resolveAppearance(s, 'other')).toEqual(DEFAULT_APPEARANCE);
  });

  it("returns a project's own appearance, clamping out-of-range opacities", () => {
    const s = settingsWith('p1', {
      ...DEFAULT_APPEARANCE,
      cardOpacity: 1.9,
      columnOpacity: -0.5,
      cardBorderOpacity: 0.8,
      cardGlassmorphism: true,
    });
    const a = resolveAppearance(s, 'p1');
    expect(a.cardOpacity).toBe(1);
    expect(a.columnOpacity).toBe(0);
    expect(a.cardBorderOpacity).toBe(0.8);
    expect(a.cardGlassmorphism).toBe(true);
  });
});

describe('isDefaultAppearance', () => {
  it('is true for the identity and false once any knob changes', () => {
    expect(isDefaultAppearance(DEFAULT_APPEARANCE)).toBe(true);
    expect(isDefaultAppearance({ ...DEFAULT_APPEARANCE, cardOpacity: 0.9 })).toBe(false);
    expect(isDefaultAppearance({ ...DEFAULT_APPEARANCE, showCardBorders: false })).toBe(false);
    expect(isDefaultAppearance({ ...DEFAULT_APPEARANCE, cardGlassmorphism: true })).toBe(false);
    expect(isDefaultAppearance({ ...DEFAULT_APPEARANCE, hideBoardScrollbar: true })).toBe(false);
  });
});

describe('appearanceView', () => {
  it('is inactive at defaults with no background (board unchanged)', () => {
    const view = appearanceView(DEFAULT_APPEARANCE, false);
    expect(view.active).toBe(false);
    expect(view.dataAttrs['data-board-appearance']).toBeUndefined();
  });

  it('activates when a background image is present even at default knobs', () => {
    const view = appearanceView(DEFAULT_APPEARANCE, true);
    expect(view.active).toBe(true);
    expect(view.dataAttrs['data-board-appearance']).toBe('on');
  });

  it('activates when a knob differs from default even without a background', () => {
    const view = appearanceView({ ...DEFAULT_APPEARANCE, columnOpacity: 0.5 }, false);
    expect(view.active).toBe(true);
  });

  it('maps opacities to CSS variables and toggles to data attributes', () => {
    const view = appearanceView(
      {
        cardOpacity: 0.5,
        columnOpacity: 0.6,
        cardBorderOpacity: 0.7,
        showColumnBorders: false,
        showCardBorders: true,
        cardGlassmorphism: true,
        hideBoardScrollbar: true,
      },
      true,
    );
    const style = view.style as Record<string, string>;
    expect(style['--nc-card-opacity']).toBe('0.5');
    expect(style['--nc-column-opacity']).toBe('0.6');
    expect(style['--nc-card-border-opacity']).toBe('0.7');
    expect(view.dataAttrs['data-card-glass']).toBe('on');
    expect(view.dataAttrs['data-column-borders']).toBe('off');
    expect(view.dataAttrs['data-card-borders']).toBe('on');
    expect(view.dataAttrs['data-hide-scrollbar']).toBe('on');
  });
});
