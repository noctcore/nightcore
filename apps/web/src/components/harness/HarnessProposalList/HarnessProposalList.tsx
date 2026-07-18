import { memo } from 'react';

import { Card, Skeleton } from '@/components/ui';

import { ARTIFACT_KIND_META } from '../harness.constants';
import type { ProposedArtifactVM } from '../harness.types';
import { useStableOnOpen } from './HarnessProposalList.hooks';
import type { HarnessProposalListProps } from './HarnessProposalList.types';

interface ArtifactGroup {
  /** Stable key (`group` id, or the artifact id for ungrouped singletons). */
  key: string;
  /** Group heading, or `null` for ungrouped singletons. */
  title: string | null;
  items: ProposedArtifactVM[];
}

/** Order artifacts into their `group` buckets (e.g. all `eslint-plugin` files
 *  together), preserving first-seen order; ungrouped artifacts become singletons.
 *  A module-level pure transform, so the component stays a thin shell. */
function groupArtifacts(artifacts: ProposedArtifactVM[]): ArtifactGroup[] {
  const groups: ArtifactGroup[] = [];
  const byKey = new Map<string, ArtifactGroup>();
  for (const a of artifacts) {
    if (a.group === null) {
      groups.push({ key: a.id, title: null, items: [a] });
      continue;
    }
    let g = byKey.get(a.group);
    if (g === undefined) {
      g = { key: a.group, title: a.groupTitle ?? a.group, items: [] };
      byKey.set(a.group, g);
      groups.push(g);
    }
    g.items.push(a);
  }
  return groups;
}

/** First few lines of an artifact's content, for the card preview. */
function previewOf(content: string): string {
  return content.split('\n').slice(0, 6).join('\n');
}

/** One artifact card: kind + write-mode badges, target path, applied state, and a
 *  truncated content preview. Clickable → the detail panel.
 *
 *  `memo`ized so a single artifact's status change (apply/dismiss) re-renders only
 *  that one card — the rest keep a stable `artifact` ref and a stable `onOpen`
 *  (see {@link useStableOnOpen}) and skip, instead of the whole list re-rendering
 *  on a per-item update. */
const ArtifactCard = memo(function ArtifactCard({
  artifact,
  onOpen,
}: {
  artifact: ProposedArtifactVM;
  onOpen: (artifact: ProposedArtifactVM) => void;
}) {
  const dimmed = artifact.status === 'dismissed';

  return (
    <Card
      onClick={() => onOpen(artifact)}
      title={dimmed ? 'Dismissed' : undefined}
      className="flex flex-col gap-2 p-3.5 text-left"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center rounded-md border border-primary/40 bg-primary/[0.1] px-1.5 py-0.5 font-mono text-3xs font-semibold text-primary">
          {ARTIFACT_KIND_META[artifact.kind].label}
        </span>
        <span className="inline-flex items-center rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground">
          {artifact.writeMode}
        </span>
        {artifact.status === 'applied' && (
          <span className="ml-auto rounded-md bg-success/[0.12] px-1.5 py-0.5 font-mono text-3xs font-semibold text-success">
            applied
          </span>
        )}
        {artifact.status === 'dismissed' && (
          <span className="ml-auto rounded-md bg-white/[0.05] px-1.5 py-0.5 font-mono text-3xs font-semibold text-muted-foreground">
            dismissed
          </span>
        )}
      </div>

      <h3 className={`text-xs-plus3 font-semibold leading-snug ${dimmed ? 'text-muted-foreground' : 'text-foreground'}`}>
        {artifact.title}
      </h3>

      <code className={`truncate font-mono text-2xs ${dimmed ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
        {artifact.appliedPath ?? artifact.targetPath}
      </code>

      <pre className="max-h-32 overflow-hidden rounded-md border border-border bg-black/20 px-2.5 py-2 font-mono text-3xs-plus leading-relaxed text-muted-foreground">
        {previewOf(artifact.content)}
      </pre>
    </Card>
  );
});

function SkeletonCard() {
  return (
    <div className="flex flex-col gap-2 rounded-nc border border-border bg-white/[0.02] p-3.5">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-4 w-14" />
      </div>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}

/** The proposed-harness panel: artifacts grouped by `group` (a plugin package's
 *  files travel together), each previewing its content. Renders skeletons while
 *  the synthesis pass is still running, and an empty message otherwise. */
export function HarnessProposalList({
  artifacts,
  loading,
  emptyMessage,
  onOpen,
}: HarnessProposalListProps) {
  // Called before the early returns so hook order stays stable across states.
  const stableOpen = useStableOnOpen(onOpen);
  if (artifacts.length === 0) {
    if (loading) {
      return (
        <div
          role="status"
          aria-busy="true"
          className="grid flex-1 grid-cols-1 content-start gap-3 overflow-y-auto px-6 py-5 sm:grid-cols-2"
        >
          <SkeletonCard />
          <SkeletonCard />
        </div>
      );
    }
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-16">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          {emptyMessage}
        </p>
      </div>
    );
  }

  const groups = groupArtifacts(artifacts);

  return (
    <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5">
      {groups.map((group) => (
        <section key={group.key} className="flex flex-col gap-2.5">
          {group.title !== null && (
            <h3 className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
              {group.title}
            </h3>
          )}
          <div className="grid grid-cols-1 content-start gap-3 sm:grid-cols-2">
            {group.items.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} onOpen={stableOpen} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
