import type { ReactNode } from 'react';
import type { PendingPermission } from '../types.js';

function compactInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return json.length > 160 ? `${json.slice(0, 157)}…` : json;
}

/**
 * Inline approval card. Rendered whenever a `permission-required` event is
 * pending; the App owns the y/n/esc keybindings that emit `approve-permission`.
 *
 * A `dangerous`-risk request (shell exec, network — arbitrary effect) is badged
 * with a red accent + label so the operator never auto-approves it by reflex.
 */
export function PermissionPrompt({
  request,
}: {
  request: PendingPermission;
}): ReactNode {
  const dangerous = request.risk === 'dangerous';
  const accent = dangerous ? '#ff5f5f' : '#ffaf00';

  return (
    <box
      title={dangerous ? 'DANGEROUS — permission required' : 'permission required'}
      style={{
        border: true,
        borderColor: accent,
        paddingLeft: 1,
        paddingRight: 1,
        flexDirection: 'column',
      }}
    >
      <text>
        <span fg={accent}>{dangerous ? '⚠ DANGER ' : '⚠ '}</span>
        <span fg="#e4e4e4">{request.title ?? `Allow ${request.toolName}?`}</span>
      </text>
      {dangerous && (
        <text fg="#ff8787">
          this tool can run arbitrary effects (shell/network) — review carefully
        </text>
      )}
      <text fg="#777777">
        {request.toolName} {compactInput(request.input)}
      </text>
      <text>
        <span fg="#5faf5f">[y] allow</span>
        <span fg="#666666">   </span>
        <span fg="#ff5f5f">[n] deny</span>
        <span fg="#666666">   </span>
        <span fg="#888888">[esc] deny</span>
      </text>
    </box>
  );
}
