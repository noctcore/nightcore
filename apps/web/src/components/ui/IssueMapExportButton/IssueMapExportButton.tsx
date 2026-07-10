/** The "Export to GitHub" trigger — a self-contained sibling of the convert-all
 *  bar in each scan-results view. Renders the button and owns the IssueMapDialog
 *  it opens, so a results view drops in `<IssueMapExportButton scanKind runId />`
 *  with no export state of its own. Gated with the bar on the completed run: a
 *  null `runId` disables it. Mints NO task and dispatches NO convert action — the
 *  export is fully orthogonal to convert-to-task. */
import { Button } from '../Button';
import { GithubIcon } from '../icons';
import { IssueMapDialog } from '../IssueMapDialog';
import { useIssueMapExportButton } from './IssueMapExportButton.hooks';
import type { IssueMapExportButtonProps } from './IssueMapExportButton.types';

export function IssueMapExportButton({ scanKind, runId }: IssueMapExportButtonProps) {
  const v = useIssueMapExportButton(runId);
  return (
    <>
      <Button variant="ghost" onClick={v.openDialog} disabled={runId === null}>
        <GithubIcon size={15} />
        Export to GitHub
      </Button>
      <IssueMapDialog
        open={v.open}
        scanKind={scanKind}
        runId={runId}
        onClose={v.closeDialog}
      />
    </>
  );
}
