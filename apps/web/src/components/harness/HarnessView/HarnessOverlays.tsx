/** The Harness slide-in detail sheets (finding / proposal / artifact) and the
 *  apply-to-disk + arm confirmation dialogs, mounted once by {@link HarnessView}. */
import { ConfirmDialog } from '@/components/ui';

import { ApplyConfirmDialog } from '../ApplyConfirmDialog';
import { ArtifactDetailPanel } from '../ArtifactDetailPanel';
import { ConventionDetailPanel } from '../ConventionDetailPanel';
import { ProposalDetailPanel } from '../ProposalDetailPanel';
import type { HarnessViewModel } from './HarnessView.types';

/** The detail sheets and confirmation dialogs rendered purely from the view model. */
export function HarnessOverlays({ view }: { view: HarnessViewModel }) {
  return (
    <>
      <ConventionDetailPanel
        open={view.selectedFinding !== null}
        finding={view.selectedFinding}
        pending={view.pending}
        onClose={view.closeFinding}
        onConvert={view.onConvertFinding}
        onDismiss={view.onDismissFinding}
        onRestore={view.onRestoreFinding}
        onGotoBoard={view.onGotoBoard}
      />

      <ProposalDetailPanel
        open={view.selectedProposal !== null}
        proposal={view.selectedProposal}
        pending={view.pending}
        onClose={view.closeProposal}
        onConvert={view.onConvertProposal}
        onApply={view.onApplyProposal}
        onDismiss={view.onDismissProposal}
        onRestore={view.onRestoreProposal}
        onGotoBoard={view.onGotoBoard}
      />

      <ArtifactDetailPanel
        open={view.selectedArtifact !== null}
        artifact={view.selectedArtifact}
        pending={view.pending}
        onClose={view.closeArtifact}
        onApply={view.requestApply}
        onDismiss={view.onDismissArtifact}
        onRestore={view.onRestoreArtifact}
        onArm={view.requestArm}
      />

      <ApplyConfirmDialog
        open={view.applyTarget !== null}
        artifact={view.applyTarget}
        applying={view.applying}
        error={view.applyError}
        onConfirm={view.confirmApply}
        onCancel={view.cancelApply}
      />

      <ConfirmDialog
        open={view.armTarget !== null}
        title="Arm this as a gauntlet check?"
        confirmLabel="Arm check"
        message={
          <>
            Add a Structure-Lock check to{' '}
            <code className="rounded border border-border bg-white/[0.04] px-1 py-0.5 font-mono text-[12px] text-foreground">
              .nightcore/harness.json
            </code>{' '}
            that runs before every task in this project (and again at merge). It will run:
            <code className="mt-2 block break-all rounded border border-border bg-white/[0.04] px-2 py-1 font-mono text-[12px] text-foreground">
              {view.armCommand}
            </code>
          </>
        }
        onConfirm={view.confirmArm}
        onCancel={view.cancelArm}
      />

      <ConfirmDialog
        open={view.applyProposalTarget !== null}
        title="Apply this bundle to disk?"
        confirmLabel={`Apply ${view.applyProposalPaths.length} ${
          view.applyProposalPaths.length === 1 ? 'file' : 'files'
        }`}
        message={
          view.applyProposalTarget !== null ? (
            <>
              Write {view.applyProposalPaths.length}{' '}
              {view.applyProposalPaths.length === 1 ? 'artifact' : 'artifacts'} from{' '}
              <span className="font-semibold text-foreground">
                {view.applyProposalTarget.title}
              </span>{' '}
              directly into the project (no agent). Existing files are never clobbered by a{' '}
              <code className="rounded border border-border bg-white/[0.04] px-1 py-0.5 font-mono text-[12px] text-foreground">
                create
              </code>{' '}
              artifact.
              {view.applyProposalPaths.length > 0 && (
                <span className="mt-2 block space-y-0.5">
                  {view.applyProposalPaths.map((path) => (
                    <code
                      key={path}
                      className="block break-all rounded border border-border bg-white/[0.04] px-2 py-1 font-mono text-[12px] text-foreground"
                    >
                      {path}
                    </code>
                  ))}
                </span>
              )}
            </>
          ) : null
        }
        onConfirm={view.confirmApplyProposal}
        onCancel={view.cancelApplyProposal}
      />
    </>
  );
}
