/** Git-detection status row under the New Project folder picker. */
import { AlertIcon, Button, CheckIcon, Spinner } from '@/components/ui';

import { useGitInit } from './GitStateRow.hooks';
import type { GitStateRowProps } from './GitStateRow.types';

/** Per-state label + text tone for the chosen folder's git status. */
const GIT_STATE_META = {
  valid: { text: 'Git repository detected.', tone: 'text-success' },
  invalid: { text: 'Not a git repository.', tone: 'text-warning' },
  checking: { text: 'Checking…', tone: 'text-muted-foreground' },
} as const;

/** The git-detection status row: a state icon (check / alert / spinner), one
 *  label, and — when the folder isn't a repo — a `git init` recovery action.
 *  `unknown` renders nothing. Replaces the old raw "✓" glyph with the shared
 *  icon set so this reads the same as the onboarding git chips. */
export function GitStateRow({ gitState, onInitGit }: GitStateRowProps) {
  const { busy, runInit } = useGitInit(onInitGit);
  if (gitState === 'unknown') return null;
  const meta = GIT_STATE_META[gitState];

  return (
    <div className={`mt-2.5 flex items-center gap-2 font-mono text-xs-flat ${meta.tone}`}>
      {gitState === 'valid' && <CheckIcon size={13} />}
      {gitState === 'invalid' && <AlertIcon size={13} />}
      {gitState === 'checking' && <Spinner size={13} />}
      <span>{meta.text}</span>
      {gitState === 'invalid' && onInitGit !== undefined && (
        <Button
          variant="ghost"
          busy={busy}
          onClick={runInit}
          className="ml-auto px-2 py-1 text-xs-flat"
        >
          git init
        </Button>
      )}
    </div>
  );
}
