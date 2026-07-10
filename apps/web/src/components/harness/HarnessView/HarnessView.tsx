/** The HarnessView component shell and its per-phase screens (CONFIGURE / RUNNING
 *  / RESULTS), rendered purely from the `useHarnessView` view model. */
import {
  BulkConvertBar,
  Button,
  ChevronLeftIcon,
  EmptyState,
  FolderIcon,
  HistoryIcon,
  IssueMapExportButton,
  Menu,
  RetryIcon,
  RunLifecycleShell,
  RunProgress,
  StopIcon,
  VerifiedIcon,
} from '@/components/ui';

import { CategoryTabs } from '../CategoryTabs';
import { ConventionGrid } from '../ConventionGrid';
import type { HarnessMode } from '../harness-sections';
import { HarnessProposalList } from '../HarnessProposalList';
import { PolicySection } from '../PolicySection';
import { ProfileBanner } from '../ProfileBanner';
import { RuleCoverageGaps } from '../RuleCoverageGaps';
import { RunControls } from '../RunControls';
import { TaskProposalList } from '../TaskProposalList';
import { HarnessOverlays } from './HarnessOverlays';
import type { HarnessSection, HarnessViewModel } from './HarnessView.hooks';
import { useHarnessView } from './HarnessView.hooks';
import type { HarnessViewProps } from './HarnessView.types';

/** Per-destination heading: the PROPOSE / ENFORCE halves title themselves so a
 *  provenance chip lands somewhere legible; the unified route stays "Harness". */
const HEADING_BY_MODE: Record<HarnessMode, string> = {
  harden: 'Harden',
  enforce: 'Enforce',
};

/** One section-toggle tab: "Conventions" / "Proposals" / "Artifacts", with a live count. */
function SectionTab({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      role="tab"
      type="button"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
        active
          ? 'bg-primary/[0.12] text-primary'
          : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
      }`}
    >
      {label}
      {count > 0 && (
        <span
          className={`rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${
            active ? 'bg-primary/20 text-primary' : 'bg-white/[0.06] text-muted-foreground'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/** CONFIGURE screen: the run-config hero + any start error. */
function ConfigureScreen({ view }: { view: HarnessViewModel }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      {view.startError !== null && (
        <p className="border-b border-destructive/40 bg-destructive/[0.1] px-6 py-2 text-[12.5px] text-destructive">
          {view.startError}
        </p>
      )}
      <RunControls
        config={view.config}
        isStarting={view.isStarting}
        onScan={view.onScan}
      />
    </div>
  );
}

/** RUNNING screen: the shared progress panel, the Cancel control, and the optional
 *  partial-reveal grid for a peeked (finished) lens. */
function RunningScreen({ view }: { view: HarnessViewModel }) {
  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[820px] flex-col gap-4 overflow-y-auto px-6 py-8">
      <RunProgress
        status={view.stream.status}
        categories={view.progressCategories}
        categoryState={view.categoryRunState}
        findingCounts={view.findingCounts}
        synthesizing={view.synthesizing}
        costUsd={view.stream.costUsd}
        usage={view.stream.usage}
        durationMs={view.stream.durationMs}
        onOpenCategory={view.openCategory}
      />

      <div className="flex justify-end">
        <Button variant="danger" onClick={view.onCancel}>
          <StopIcon size={15} />
          Cancel scan
        </Button>
      </div>

      {view.peekCategory !== null && (
        <div className="flex max-h-[60vh] min-h-0 flex-col overflow-hidden rounded-[10px] border border-border bg-white/[0.015]">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              {view.peekLabel}
            </span>
            <button
              type="button"
              onClick={view.clearPeek}
              className="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeftIcon size={13} />
              Back to progress
            </button>
          </div>
          <ConventionGrid
            findings={view.peekFindings}
            skeletonCount={0}
            emptyMessage="No findings in this lens."
            onOpen={view.openFinding}
          />
        </div>
      )}
    </div>
  );
}

/** RESULTS screen: the detected-profile banner, the section toggle, and the
 *  tabbed convention grid or the proposed-harness list. */
function ResultsScreen({
  view,
  setSection,
}: {
  view: HarnessViewModel;
  setSection: (section: HarnessSection) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {view.stream.status === 'failed' &&
        (view.stream.failureReason === 'aborted' ? (
          <div className="border-b border-border bg-white/[0.02] px-6 py-3">
            <p className="text-[12.5px] text-muted-foreground">
              Scan cancelled. Any findings that streamed before you stopped the scan
              are shown below.
            </p>
          </div>
        ) : (
          <div className="border-b border-destructive/40 bg-destructive/[0.08] px-6 py-3">
            <p className="text-[12.5px] text-destructive">
              Scan failed
              {view.stream.error !== null ? `: ${view.stream.error}` : '.'} Any findings
              that streamed before the failure are shown below.
            </p>
          </div>
        ))}

      {view.showProfileBanner && (
        <ProfileBanner profile={view.stream.profile} loading={view.profileLoading} />
      )}

      {/* Section toggle — the mode filter decides which tabs render (harden shows
          Proposals + Artifacts, enforce shows Conventions + Policy). */}
      <div
        role="tablist"
        aria-label="Harness sections"
        className="flex items-center gap-1 border-b border-border px-6 py-2"
      >
        {view.sectionTabs.map((tab) => (
          <SectionTab
            key={tab.key}
            label={tab.label}
            count={tab.count}
            active={view.section === tab.key}
            onClick={() => setSection(tab.key)}
          />
        ))}
      </div>

      {view.section === 'conventions' && (
        <>
          {view.stream.status === 'completed' && (
            <BulkConvertBar
              {...view.conventionsBulk}
              trailing={
                <IssueMapExportButton scanKind="enforce" runId={view.stream.runId} />
              }
            />
          )}
          <CategoryTabs tabs={view.tabs} active={view.activeTab} onSelect={view.setActiveTab} />
          <ConventionGrid
            findings={view.gridFindings}
            skeletonCount={view.skeletonCount}
            emptyMessage={view.emptyMessage}
            onOpen={view.openFinding}
            coverageByFingerprint={view.showCoverage ? view.coverageByFingerprint : undefined}
          />
          {view.showCoverage && <RuleCoverageGaps gaps={view.coverage} />}
        </>
      )}
      {view.section === 'proposals' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {view.stream.status === 'completed' && (
            <BulkConvertBar {...view.proposalsBulk} />
          )}
          <TaskProposalList
            proposals={view.proposals}
            loading={view.proposalsLoading}
            emptyMessage={view.proposalsEmptyMessage}
            onOpen={view.openProposal}
          />
        </div>
      )}
      {view.section === 'artifacts' && (
        <HarnessProposalList
          artifacts={view.artifacts}
          loading={view.artifactsLoading}
          emptyMessage={view.artifactsEmptyMessage}
          onOpen={view.openArtifact}
        />
      )}
      {view.section === 'policy' && <PolicySection />}
    </div>
  );
}

/** The Harness surface, organized as three swapping lifecycle screens (CONFIGURE /
 *  RUNNING / RESULTS) inside the shared `RunLifecycleShell`: the run-config hero, the
 *  live progress panel, and the section-toggled results (convention grid / proposed
 *  harness), plus the slide-in detail sheets and the apply-to-disk confirmation. */
export function HarnessView(props: HarnessViewProps) {
  const view = useHarnessView(props);
  const heading = props.mode !== undefined ? HEADING_BY_MODE[props.mode] : 'Harness';

  if (!view.hasProject) {
    return (
      <EmptyState
        icon={<FolderIcon size={32} />}
        title="No active project"
        description="Open a project to audit its conventions. Harness runs over the active project's repo."
      />
    );
  }

  const actions = (
    <>
      {view.hasHistory && (
        <Menu
          label="Run history"
          items={view.runHistory}
          align="right"
          trigger={
            <Button variant="ghost">
              <HistoryIcon size={14} />
              History
            </Button>
          }
        />
      )}
      {view.phase === 'results' && (
        <Button variant="ghost" onClick={view.reconfigure}>
          <RetryIcon size={14} />
          New run
        </Button>
      )}
    </>
  );

  const summary =
    view.phase === 'running' ? (
      view.summary
    ) : (
      <button
        type="button"
        onClick={view.reconfigure}
        className="text-left transition-colors hover:text-foreground"
      >
        {view.summary}
        <span className="sr-only"> Reconfigure run</span>
      </button>
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunLifecycleShell
        title={
          <span className="flex items-center gap-2">
            <VerifiedIcon size={16} className="text-primary" />
            {heading}
          </span>
        }
        subtitle={view.projectName ?? 'Convention audit'}
        phase={view.phase}
        summary={summary}
        actions={actions}
      >
        {view.phase === 'configure' && <ConfigureScreen view={view} />}
        {view.phase === 'running' && <RunningScreen view={view} />}
        {view.phase === 'results' && (
          <ResultsScreen view={view} setSection={view.setSection} />
        )}
      </RunLifecycleShell>

      <HarnessOverlays view={view} />
    </div>
  );
}
