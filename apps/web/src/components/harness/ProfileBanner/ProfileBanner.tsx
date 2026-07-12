import { Badge, Skeleton } from '@/components/ui';

import type { RepoProfileVM } from '../harness.types';
import type { ProfileBannerProps } from './ProfileBanner.types';

/** A small labelled flag chip: tinted when the capability is present, muted when
 *  absent (so the user sees what the repo already has vs. what the harness adds). */
function Flag({ label, on }: { label: string; on: boolean }) {
  return (
    <span
      aria-label={`${label}: ${on ? 'present' : 'absent'}`}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-3xs ${
        on
          ? 'border-success/40 bg-success/[0.1] text-success'
          : 'border-border bg-white/[0.02] text-muted-foreground'
      }`}
    >
      <span aria-hidden>{on ? '✓' : '–'}</span>
      {label}
    </span>
  );
}

function Chips({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </span>
      {values.map((v) => (
        <span
          key={v}
          className="rounded-md border border-border bg-white/[0.03] px-1.5 py-0.5 font-mono text-3xs text-muted-foreground"
        >
          {v}
        </span>
      ))}
    </div>
  );
}

function ProfileContent({ profile }: { profile: RepoProfileVM }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="primary">{profile.isMonorepo ? 'Monorepo' : 'Single package'}</Badge>
        <Badge>{profile.workspaceTool}</Badge>
        {profile.isMonorepo && (
          <Badge>
            {profile.packages.length} package{profile.packages.length === 1 ? '' : 's'}
          </Badge>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Chips label="Languages" values={profile.languages} />
        <Chips label="Frameworks" values={profile.frameworks} />
        {profile.existingPlugins.length > 0 && (
          <Chips label="Plugins" values={profile.existingPlugins} />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Flag label="eslint flat config" on={profile.hasEslintFlatConfig} />
        <Flag label="lint-meta" on={profile.hasLintMeta} />
        <Flag label="agent docs" on={profile.hasAgentDocs} />
      </div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-20" />
      </div>
      <Skeleton className="h-4 w-2/3" />
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-5 w-20" />
        <Skeleton className="h-5 w-24" />
      </div>
    </div>
  );
}

/** The detected-repo-profile banner. Renders the deterministic profile (monorepo
 *  badge, workspace tool, package count, language/framework chips, and capability
 *  flags) once `harness-profile-ready` lands; a skeleton while a scan is in flight
 *  and the profile hasn't arrived; nothing at all when idle. */
export function ProfileBanner({ profile, loading }: ProfileBannerProps) {
  if (profile === null && !loading) return null;

  return (
    <div
      role={profile === null ? 'status' : undefined}
      aria-busy={profile === null ? true : undefined}
      className="flex flex-col gap-2 border-b border-border bg-white/[0.01] px-6 py-4"
    >
      <span className="font-mono text-3xs uppercase tracking-[0.1em] text-muted-foreground">
        Detected profile
      </span>
      {profile === null ? <ProfileSkeleton /> : <ProfileContent profile={profile} />}
    </div>
  );
}
