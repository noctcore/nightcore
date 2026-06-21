import type { ReactNode } from 'react';
import type { PermissionMode, SessionStatus } from '@nightcore/contracts';
import type { SessionView } from '../types.js';
import { formatDuration, formatUsage } from '../format.js';

interface SessionHeaderProps {
  view: SessionView;
}

const STATUS_LABEL: Record<SessionStatus | 'idle', string> = {
  idle: 'idle',
  starting: 'starting',
  running: 'streaming',
  'awaiting-permission': 'awaiting approval',
  completed: 'done',
  failed: 'failed',
  interrupted: 'interrupted',
};

const STATUS_COLOR: Record<SessionStatus | 'idle', string> = {
  idle: '#888888',
  starting: '#d7af00',
  running: '#5fafff',
  'awaiting-permission': '#ffaf00',
  completed: '#5faf5f',
  failed: '#ff5f5f',
  interrupted: '#ff875f',
};

/** plan = read-only research; build = auto-accept edits. */
function modeLabel(mode: PermissionMode): string {
  if (mode === 'plan') return 'PLAN';
  if (mode === 'acceptEdits') return 'BUILD';
  return mode;
}

export function SessionHeader({ view }: SessionHeaderProps): ReactNode {
  const cost = view.costUsd !== null ? `$${view.costUsd.toFixed(4)}` : '—';
  return (
    <box
      style={{
        flexDirection: 'row',
        justifyContent: 'space-between',
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: '#1a1a24',
      }}
    >
      <text>
        <strong>nightcore</strong>
        <span fg="#666666">  {view.model}</span>
      </text>
      <text>
        <span fg={view.permissionMode === 'plan' ? '#5fafff' : '#5faf5f'}>
          {modeLabel(view.permissionMode)}
        </span>
        <span fg="#666666">  status </span>
        <span fg={STATUS_COLOR[view.status]}>{STATUS_LABEL[view.status]}</span>
        <span fg="#666666">  cost </span>
        <span fg="#bbbbbb">{cost}</span>
        {/* Duration + tokens appear once a session completes (the stats the SDK
            only reports at the end). Kept compact so the header stays uncluttered. */}
        {view.durationMs !== null && (
          <span fg="#8a8a8a">{`  ${formatDuration(view.durationMs)}`}</span>
        )}
        {view.usage !== null && (
          <span fg="#8a8a8a">{`  ${formatUsage(view.usage)}`}</span>
        )}
      </text>
    </box>
  );
}
