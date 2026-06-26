import {
  Button,
  EmptyState,
  FolderIcon,
  HistoryIcon,
  InsightIcon,
  Menu,
} from '@/components/ui';
import { CategoryTabs } from '../CategoryTabs';
import { FindingDetailPanel } from '../FindingDetailPanel';
import { FindingGrid } from '../FindingGrid';
import { RunControls } from '../RunControls';
import { useInsightView } from './InsightView.hooks';
import type { InsightViewProps } from './InsightView.types';

/** The Insight surface: run controls, a tabbed-by-category finding grid with
 *  streaming skeletons, and a slide-in detail panel with convert/dismiss actions. */
export function InsightView(props: InsightViewProps) {
  const view = useInsightView(props);

  if (!view.hasProject) {
    return (
      <EmptyState
        icon={<FolderIcon size={32} />}
        title="No active project"
        description="Open a project to analyze its codebase. Insight runs over the active project's repo."
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-6 py-4">
        <InsightIcon size={18} className="text-primary" />
        <div className="flex flex-col">
          <h1 className="text-[15px] font-semibold text-foreground">Insight</h1>
          <span className="text-[12px] text-muted-foreground">
            {view.projectName ?? 'Codebase analysis'}
          </span>
        </div>
        {view.hasHistory && (
          <div className="ml-auto">
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
          </div>
        )}
      </div>

      <RunControls
        stream={view.stream}
        isStarting={view.isStarting}
        disabled={!view.hasProject}
        onAnalyze={view.onAnalyze}
        onCancel={view.onCancel}
      />

      {view.startError !== null && (
        <p className="border-b border-destructive/40 bg-destructive/[0.1] px-6 py-2 text-[12.5px] text-destructive">
          {view.startError}
        </p>
      )}

      <CategoryTabs
        tabs={view.tabs}
        active={view.activeTab}
        onSelect={view.setActiveTab}
      />

      <FindingGrid
        findings={view.gridFindings}
        skeletonCount={view.skeletonCount}
        emptyMessage={view.emptyMessage}
        onOpen={view.openFinding}
      />

      {view.selected !== null && (
        <FindingDetailPanel
          finding={view.selected}
          pending={view.pending}
          onClose={view.closeFinding}
          onConvert={view.onConvert}
          onDismiss={view.onDismiss}
          onRestore={view.onRestore}
          onGotoBoard={view.onGotoBoard}
        />
      )}
    </div>
  );
}
