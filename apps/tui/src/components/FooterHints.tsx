import type { ReactNode } from 'react';
import type { PermissionMode } from '@nightcore/contracts';

interface FooterHintsProps {
  busy: boolean;
  mode: PermissionMode;
}

const nextMode = (mode: PermissionMode): string =>
  mode === 'plan' ? 'build' : 'plan';

export function FooterHints({ busy, mode }: FooterHintsProps): ReactNode {
  return (
    <box style={{ paddingLeft: 1, paddingRight: 1 }}>
      <text fg="#555566">
        enter submit · shift+enter newline · shift+tab → {nextMode(mode)} ·{' '}
        {busy ? 'esc interrupt' : 'esc'} · /help · ctrl+c quit
      </text>
    </box>
  );
}
