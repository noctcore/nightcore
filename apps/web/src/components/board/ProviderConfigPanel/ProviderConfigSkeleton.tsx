/** The loading placeholder for the provider-config inspector body. */
import { Skeleton } from '@/components/ui';

/** One skeleton section card mirroring the real `Section` chrome: a bordered
 *  header (icon + title) and a body of placeholder rows. Keeps the loading state
 *  structurally identical to the loaded layout so data arrival causes no shift. */
function SkeletonSection({ rows = 3 }: { rows?: number }) {
  return (
    <section className="rounded-[10px] border border-border bg-white/[0.02]">
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
        <Skeleton className="h-3.5 w-3.5 rounded" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3.5 w-6 rounded-md" />
      </div>
      <div className="flex flex-col gap-3 px-3.5 py-3">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <Skeleton
              className={`h-3 ${i % 2 === 0 ? 'w-40' : 'w-28'}`}
            />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** The loading placeholder for the panel body — four skeleton sections matching
 *  MCP servers, Skills, Subagents, and Defaults. */
export function ProviderConfigSkeleton() {
  return (
    <>
      <SkeletonSection rows={3} />
      <SkeletonSection rows={3} />
      <SkeletonSection rows={2} />
      <SkeletonSection rows={3} />
    </>
  );
}
