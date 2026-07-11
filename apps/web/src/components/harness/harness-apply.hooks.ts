/** The Harness file-level artifacts concern — split out of the HarnessView
 *  mega-hook: the artifact detail selection, the apply-to-disk confirm flow
 *  (its own in-flight + inline-error state, since a refused overwrite must not be
 *  swallowed), and the arm-as-gauntlet-check confirm flow. */
import { useCallback, useMemo, useState } from 'react';

import type { ToastApi } from '@/components/ui';

import type { ProposedArtifactVM } from './harness.types';
import type { UseHarnessResult } from './harness-data.hooks';
import type { HarnessStream } from './harness-stream';

/** The Rust check kind + suggested command shown (verbatim) when arming an eslint-class
 *  artifact as a gauntlet check. `lint-plugin` is the gauntlet's kind for an ESLint gate;
 *  `npx eslint .` is the conventional whole-repo lint the user reviews + confirms. */
const ARM_SUGGESTION = { kind: 'lint-plugin', command: 'npx eslint .' } as const;

/** What the artifacts/apply concern reads (threaded by the view-model composition). */
export interface HarnessApplyConfig {
  stream: HarnessStream;
  harness: UseHarnessResult;
  /** Run one item action behind `pending` with a labeled failure toast. */
  runAction: (label: string, fn: () => Promise<unknown>) => Promise<void>;
  toast: ToastApi;
}

/** The artifacts + apply/arm slice the HarnessView shell renders. */
export interface HarnessApplyApi {
  artifacts: ProposedArtifactVM[];
  artifactCount: number;
  artifactsLoading: boolean;
  artifactsEmptyMessage: string;
  selectedArtifact: ProposedArtifactVM | null;
  openArtifact: (artifact: ProposedArtifactVM) => void;
  closeArtifact: () => void;
  onDismissArtifact: (artifactId: string) => void;
  onRestoreArtifact: (artifactId: string) => void;
  /** The artifact awaiting apply confirmation, or `null` (drives the dialog). */
  applyTarget: ProposedArtifactVM | null;
  applying: boolean;
  applyError: string | null;
  requestApply: (artifactId: string) => void;
  confirmApply: () => void;
  cancelApply: () => void;
  /** The applied artifact awaiting arm confirmation, or `null` (drives the arm dialog). */
  armTarget: ProposedArtifactVM | null;
  /** The command that arming will write to the manifest (shown verbatim — the gate). */
  armCommand: string;
  requestArm: (artifactId: string) => void;
  confirmArm: () => void;
  cancelArm: () => void;
}

/** Own the artifact detail selection + the apply-to-disk + arm confirm flows. */
export function useHarnessApply({
  stream,
  harness,
  runAction,
  toast,
}: HarnessApplyConfig): HarnessApplyApi {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [applyTargetId, setApplyTargetId] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [armTargetId, setArmTargetId] = useState<string | null>(null);

  const selectedArtifact = useMemo(
    () => stream.artifacts.find((a) => a.id === selectedArtifactId) ?? null,
    [stream.artifacts, selectedArtifactId],
  );
  const applyTarget = useMemo(
    () => stream.artifacts.find((a) => a.id === applyTargetId) ?? null,
    [stream.artifacts, applyTargetId],
  );
  const armTarget = useMemo(
    () => stream.artifacts.find((a) => a.id === armTargetId) ?? null,
    [stream.artifacts, armTargetId],
  );

  const artifactsEmptyMessage = useMemo(() => {
    if (stream.status === 'idle') {
      return 'Run a scan to synthesize a proposed harness from your conventions.';
    }
    if (stream.status === 'failed') {
      return `Scan failed${stream.error !== null ? `: ${stream.error}` : ''}.`;
    }
    return 'No harness artifacts proposed for this scan.';
  }, [stream.status, stream.error]);

  const confirmApply = useCallback(() => {
    if (applyTargetId === null) return;
    const id = applyTargetId;
    setApplying(true);
    setApplyError(null);
    void (async () => {
      try {
        await harness.applyArtifact(id);
        setApplyTargetId(null);
      } catch (err) {
        setApplyError(err instanceof Error ? err.message : String(err));
      } finally {
        setApplying(false);
      }
    })();
  }, [applyTargetId, harness]);

  const cancelApply = useCallback(() => {
    if (applying) return;
    setApplyTargetId(null);
    setApplyError(null);
  }, [applying]);

  const confirmArm = useCallback(() => {
    const target = stream.artifacts.find((a) => a.id === armTargetId) ?? null;
    if (target === null) return;
    const name = target.groupTitle ?? target.title;
    // The applied plugin's path (fallback to its proposed target) lets Rust refuse
    // a placebo `lint-plugin` arm — one whose plugin no ESLint config wires in.
    const requireWired = target.appliedPath ?? target.targetPath;
    setArmTargetId(null);
    void runAction('arm gauntlet check', async () => {
      await harness.armCheck(name, ARM_SUGGESTION.kind, ARM_SUGGESTION.command, requireWired);
      toast.push({
        tone: 'success',
        title: 'Structure-Lock check armed',
        description: `${name} now runs before every task in this project.`,
      });
    });
  }, [stream.artifacts, armTargetId, runAction, harness, toast]);

  const cancelArm = useCallback(() => setArmTargetId(null), []);

  return {
    artifacts: stream.artifacts,
    artifactCount: stream.artifacts.filter((a) => a.status === 'proposed').length,
    artifactsLoading: stream.status === 'running' && stream.artifacts.length === 0,
    artifactsEmptyMessage,
    selectedArtifact,
    openArtifact: (artifact) => setSelectedArtifactId(artifact.id),
    closeArtifact: () => setSelectedArtifactId(null),
    onDismissArtifact: (id) =>
      void runAction('dismiss artifact', () => harness.dismissArtifact(id)),
    onRestoreArtifact: (id) =>
      void runAction('restore artifact', () => harness.restoreArtifact(id)),
    applyTarget,
    applying,
    applyError,
    requestApply: (id) => {
      setApplyError(null);
      setApplyTargetId(id);
    },
    confirmApply,
    cancelApply,
    armTarget,
    armCommand: ARM_SUGGESTION.command,
    requestArm: (id) => setArmTargetId(id),
    confirmArm,
    cancelArm,
  };
}
