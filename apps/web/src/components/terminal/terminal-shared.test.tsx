import { describe, expect, test } from 'vitest';

import {
  displayPath,
  gridColumns,
  resolveTerminalTheme,
  terminalLabel,
  unreadBadge,
} from './terminal-shared';

// Pure-string tests (no PTY, no host dependence) — these prove the Windows
// verbatim-prefix display fix on any CI host, including the Linux/macOS boxes that
// never produce a `\\?\` path themselves.

describe('displayPath', () => {
  test('strips the Windows verbatim drive prefix (the reported picker bug)', () => {
    expect(displayPath('\\\\?\\X:\\dev\\nightcore')).toBe('X:\\dev\\nightcore');
  });

  test('rewrites a verbatim UNC prefix to a normal UNC path', () => {
    expect(displayPath('\\\\?\\UNC\\server\\share\\wt')).toBe('\\\\server\\share\\wt');
  });

  test('passes POSIX paths through untouched', () => {
    expect(displayPath('/Users/dev/nightcore')).toBe('/Users/dev/nightcore');
    expect(displayPath('/bin/zsh')).toBe('/bin/zsh');
  });

  test('passes already-clean Windows paths through untouched', () => {
    expect(displayPath('C:\\dev\\nightcore')).toBe('C:\\dev\\nightcore');
  });

  test('is idempotent (prettifying a prettified path is a no-op)', () => {
    const once = displayPath('\\\\?\\X:\\dev\\nightcore');
    expect(displayPath(once)).toBe(once);
  });
});

describe('terminalLabel', () => {
  test('takes the last segment of a POSIX path', () => {
    expect(terminalLabel('/Users/dev/nightcore')).toBe('nightcore');
  });

  test('takes the last segment of a Windows path (splits on both separators)', () => {
    expect(terminalLabel('X:\\dev\\nightcore')).toBe('nightcore');
  });

  test('strips the verbatim prefix before labeling a Windows worktree cwd', () => {
    expect(
      terminalLabel('\\\\?\\X:\\dev\\nightcore\\.nightcore\\worktrees\\task-42'),
    ).toBe('task-42');
  });
});

describe('gridColumns', () => {
  test('maps the session count to the locked column count (decision 1)', () => {
    // 1→1×1, 2→1×2, ≤4→2×2, ≤6→2×3, ≤9→3×3, else (10–12) 3×4.
    expect(gridColumns(1)).toBe(1);
    expect(gridColumns(2)).toBe(2);
    expect(gridColumns(3)).toBe(2);
    expect(gridColumns(4)).toBe(2);
    expect(gridColumns(5)).toBe(3);
    expect(gridColumns(6)).toBe(3);
    expect(gridColumns(7)).toBe(3);
    expect(gridColumns(9)).toBe(3);
    expect(gridColumns(10)).toBe(4);
    expect(gridColumns(12)).toBe(4);
  });

  test('clamps a zero/negative count to one column', () => {
    expect(gridColumns(0)).toBe(1);
    expect(gridColumns(-3)).toBe(1);
  });
});

describe('unreadBadge', () => {
  test('shows the raw count, clamping past 99 to 99+', () => {
    expect(unreadBadge(0)).toBe('0');
    expect(unreadBadge(7)).toBe('7');
    expect(unreadBadge(99)).toBe('99');
    expect(unreadBadge(128)).toBe('99+');
  });
});

describe('resolveTerminalTheme', () => {
  // #235: the xterm theme must come from the live design tokens, not hand-eyeballed
  // hex restatements that silently drift from styles.css. These run in the real test
  // browser, so we drive the resolver by setting the `--nc-*` custom properties inline
  // on the document root and asserting they flow through verbatim.
  test('reads the live --nc-* tokens for background/foreground/cursor and derives selection from primary', () => {
    const root = document.documentElement;
    root.style.setProperty('--nc-background', 'oklch(9% 0.035 280)');
    root.style.setProperty('--nc-foreground', 'oklch(97% 0.015 290)');
    root.style.setProperty('--nc-primary', 'oklch(78% 0.22 290)');
    try {
      const theme = resolveTerminalTheme();
      expect(theme.background).toBe('oklch(9% 0.035 280)');
      expect(theme.foreground).toBe('oklch(97% 0.015 290)');
      expect(theme.cursor).toBe('oklch(78% 0.22 290)');
      // Selection is the primary at 30% via color-mix (already used in styles.css).
      expect(theme.selectionBackground).toBe(
        'color-mix(in oklch, oklch(78% 0.22 290) 30%, transparent)',
      );
    } finally {
      root.style.removeProperty('--nc-background');
      root.style.removeProperty('--nc-foreground');
      root.style.removeProperty('--nc-primary');
    }
  });

  test('falls back to the shipped cosmic-dark hex when a token is unreadable (stylesheet-less host)', () => {
    const root = document.documentElement;
    // Force the tokens empty so the fallback branch is exercised deterministically.
    root.style.setProperty('--nc-background', '');
    root.style.setProperty('--nc-foreground', '');
    root.style.setProperty('--nc-primary', '');
    try {
      const theme = resolveTerminalTheme();
      // Every field is a non-empty, xterm-parseable color (never '' — which would
      // throw inside xterm's color parser).
      expect(theme.background).toBeTruthy();
      expect(theme.foreground).toBeTruthy();
      expect(theme.cursor).toBeTruthy();
      expect(theme.selectionBackground).toBeTruthy();
    } finally {
      root.style.removeProperty('--nc-background');
      root.style.removeProperty('--nc-foreground');
      root.style.removeProperty('--nc-primary');
    }
  });
});
