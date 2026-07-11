/** GitHub two-way issue sync settings cards (#97, PR 1) — split from settings-cards
 *  to stay under the file-size ratchet, mirroring settings-interface-cards. */
import { GithubIcon, Toggle } from '@/components/ui';
import type { Settings, SettingsPatch } from '@/lib/bridge';

import type { SettingsCardProps } from './SettingsCard';

/** A single-line text input bound to the status-label prefix. Uncontrolled (commits
 *  on blur / Enter, like NumberField) so a keystroke doesn't persist settings.json.
 *  An empty/blank commit clears the prefix back to the default `nc:` — the Rust merge
 *  treats a blank value as the reset sentinel (mirrors `preferredEditor`). */
function LabelPrefixField({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (next: string) => void;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-black/20 px-2.5 py-1.5 focus-within:border-primary">
      <input
        type="text"
        aria-label="GitHub status label prefix"
        defaultValue={value}
        key={value}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        onBlur={(e) => onCommit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onCommit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          }
        }}
        className="w-[110px] bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/60"
      />
    </div>
  );
}

/** Build the GitHub integration cards for the Integrations (hooks) page. Global-only
 *  settings (like native notifications), so both controls patch the global block.
 *
 *  The toggle is LIVE (#97, PR 3): enabling it arms the writeback observer, so a
 *  linked task's lifecycle projects onto its GitHub issue (`nc:*` labels + terminal
 *  comments) and its PR gets `Closes #N`. Off by default — writeback mutates a
 *  (often public) repo, so it is opt-in and needs a token with issue-write scope. */
export function buildGithubCards(
  settings: Settings,
  patchGlobal: (patch: SettingsPatch) => void,
): SettingsCardProps[] {
  return [
    {
      icon: <GithubIcon size={18} />,
      title: 'GitHub issue sync',
      subtitle:
        'Project a linked task’s lifecycle onto the GitHub issue it was converted from.',
      rows: [
        {
          label: 'Two-way issue sync',
          hint: 'Off by default. When on, Nightcore keeps nc:* status labels and posts terminal comments on the linked issue, and adds Closes #N to the task’s PR so a merge closes the issue. Needs a token with issue write access; if it can’t write, sync degrades and the task shows a notice.',
          control: (
            <Toggle
              on={settings.issueSyncEnabled}
              onChange={(next) => patchGlobal({ issueSyncEnabled: next })}
              label="Enable GitHub two-way issue sync"
            />
          ),
        },
        {
          label: 'Status label prefix',
          hint: 'Prefix for the status labels Nightcore manages on issues (e.g. nc: → nc:queued). Empty resets to nc:.',
          control: (
            <LabelPrefixField
              value={settings.issueLabelPrefix ?? ''}
              placeholder="nc:"
              onCommit={(v) => patchGlobal({ issueLabelPrefix: v })}
            />
          ),
        },
      ],
    },
  ];
}
