import {
  AlertIcon,
  Button,
  CheckIcon,
  FolderIcon,
  Spinner,
} from '@/components/ui';

import type { OnboardingProps } from '../../Onboarding.types';
import { useProjectStep } from './ProjectStep.hooks';
import type { ProjectStepProps } from './ProjectStep.types';

export function ProjectStep({ props, view }: ProjectStepProps) {
  const { folderPicked, gitInitBusy, runGitInit } = useProjectStep(props);
  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <h1 className="text-[19px] font-semibold tracking-tight">First project</h1>
        <p className="mt-1 text-xs-plus text-muted-foreground">
          Point Nightcore at a git repo. Each project gets its own board, worktrees,
          and settings.
        </p>
      </div>
      <button
        type="button"
        onClick={() => void props.onChooseFolder()}
        className={`flex w-full items-center gap-3 rounded-[12px] border border-dashed px-3.5 py-3 text-left transition-colors ${
          folderPicked
            ? 'border-border bg-white/[0.025] hover:bg-white/[0.04]'
            : 'border-primary/50 bg-primary/[0.05] hover:bg-primary/[0.08]'
        }`}
      >
        <div className="flex size-[30px] shrink-0 items-center justify-center rounded-[8px] bg-primary/15 text-primary">
          <FolderIcon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div
            className={`text-xs-plus font-semibold ${
              folderPicked ? 'text-foreground' : 'text-muted-foreground'
            }`}
          >
            {folderPicked ? 'Repository selected' : 'Choose repository folder'}
          </div>
          <div className="mt-0.5 truncate font-mono text-3xs text-muted-foreground">
            {props.folder ?? 'No folder selected'}
          </div>
        </div>
        <span className="shrink-0 text-xs-flat font-semibold text-primary">
          {folderPicked ? 'Change' : 'Choose'}
        </span>
      </button>
      {folderPicked && (
        <>
          <GitStatus
            gitState={props.gitState}
            onInitGit={props.onInitGit}
            busy={gitInitBusy}
            onRunInit={runGitInit}
          />
          <label className="block">
            <span className="mb-1.5 block text-2xs font-semibold text-muted-foreground">
              Project name
            </span>
            <input
              value={view.projectName}
              onChange={(event) => view.setProjectName(event.target.value)}
              className="w-full rounded-nc border border-border bg-black/25 px-3 py-2.5 text-xs-plus2 text-foreground outline-none focus:border-primary"
              placeholder="my-project"
            />
          </label>
        </>
      )}
    </div>
  );
}

function GitStatus({
  gitState,
  onInitGit,
  busy,
  onRunInit,
}: Pick<OnboardingProps, 'gitState' | 'onInitGit'> & {
  busy: boolean;
  onRunInit: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {gitState === 'valid' && (
        <span className="flex items-center gap-1.5 rounded-[6px] border border-success/30 bg-success/[0.06] px-2 py-1 font-mono text-3xs text-success">
          <CheckIcon size={11} />
          git repo detected
        </span>
      )}
      {gitState === 'checking' && (
        <span className="flex items-center gap-1.5 rounded-[6px] border border-border bg-white/[0.03] px-2 py-1 font-mono text-3xs text-muted-foreground">
          <Spinner size={11} />
          checking git
        </span>
      )}
      {gitState === 'invalid' && (
        <span className="flex items-center gap-1.5 rounded-[6px] border border-warning/35 bg-warning/[0.08] px-2 py-1 font-mono text-3xs text-warning">
          <AlertIcon size={11} />
          not a git repo
        </span>
      )}
      {gitState === 'invalid' && onInitGit !== undefined && (
        <Button
          variant="ghost"
          busy={busy}
          onClick={onRunInit}
          className="rounded-[6px] px-2 py-1 text-3xs"
        >
          git init
        </Button>
      )}
    </div>
  );
}
