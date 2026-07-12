/** State, validation, submit, and keyboard/paste handling for the create-task
 *  dialog. */
import { useCallback, useEffect, useState } from 'react';

import { useProviderCapabilities } from '@/components/ui';
import {
  imageFilesFrom,
  MAX_IMAGES_PER_TASK,
  type PendingAttachment,
  readImageFiles,
  toPayload,
} from '@/lib/attachments';
import type { BranchInfo, PermissionMode, RunMode, TaskKind } from '@/lib/bridge';
import { getHarnessPolicyFile, listBranches } from '@/lib/bridge';
import { governanceWarningFor, harnessPolicyHasRules } from '@/lib/harness-governance';
import { capabilitiesForProvider, runCeilingCaveatFor } from '@/lib/provider-capabilities';

import type { NewTaskFormProps } from './NewTaskForm.types';

/** Parse a positive-integer ceiling from free text; `null` for blank/invalid
 *  input (⇒ inherit the resolved default). */
function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse a positive float ceiling from free text; `null` for blank/invalid input
 *  (⇒ inherit the resolved default). `0` is invalid — the wire contract is
 *  `maxBudgetUsd: positive().optional()`, and a $0 ceiling would be unrunnable. */
function parsePositiveFloat(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * The resolved default for the "Plan first" toggle (T6, #147). The plan-approval gate
 * is default-ON at the INTERACTIVE create seam, but ONLY for a `build` task, ONLY when
 * the studio-wide `planGateDefault` is on, AND ONLY when the resolved provider supports
 * the gate (its hooks / `canUseTool` channel parks `ExitPlanMode`). A non-Build kind, a
 * disabled gate, or a hookless provider (Codex) all default OFF — the last one is Fix 3:
 * a plan-mode run there would surface no plan and silently no-op.
 */
export function planFirstDefault(
  kind: TaskKind,
  planGateDefault: boolean,
  providerSupportsPlanGate: boolean,
): boolean {
  return kind === 'build' && planGateDefault && providerSupportsPlanGate;
}

/** The create-task form's full state plus its field setters and action
 *  handlers, returned by {@link useNewTaskForm}. */
export interface NewTaskFormState {
  title: string;
  description: string;
  kind: TaskKind;
  runMode: RunMode;
  /** Chosen worktree branch name (empty ⇒ default `nc/<taskId>`). Worktree mode only. */
  branch: string;
  /** Chosen base branch (empty ⇒ the project's current branch). Worktree mode only. */
  baseBranch: string;
  /** Available branches for the picker (local + remote-tracking). */
  branches: BranchInfo[];
  permissionMode: PermissionMode | null;
  /** Plan-approval gate (T6, #147): the "Plan first" toggle. Seeded from the kind +
   *  the global `planGateDefault` + the provider capability (Build defaults on),
   *  overridable per task. */
  planFirst: boolean;
  /** Whether the resolved provider supports the plan-approval gate (has the hooks /
   *  `canUseTool` channel that parks `ExitPlanMode`). `false` on Codex — the toggle is
   *  rendered non-interactive so a plan can't be forced into a silent no-op. */
  providerSupportsPlanGate: boolean;
  /** Provider/governance mismatch warning (#296): non-null when the active
   *  project's Harness policy is ARMED (a real rule, not just an empty manifest)
   *  and the picked provider can't enforce it — creating the task would run and
   *  then be REFUSED at dispatch. `null` when there's nothing to warn about. */
  governanceWarning: string | null;
  /** Caveat (#296 item 5) when the picked provider can't enforce the per-run
   *  maxTurns / maxBudget ceilings (Codex's SDK has no such control), so those
   *  fields would be silently ignored. `null` when both are supported or unknown. */
  runCeilingCaveat: string | null;
  model: string | null;
  /** The provider the picked model belongs to (B5), stamped so a created task
   *  round-trips its selection's provider. `undefined` ⇒ derive from the model id. */
  providerId: string | undefined;
  effort: string | null;
  /** Raw text of the optional max-turns ceiling (empty = inherit). */
  maxTurns: string;
  /** Raw text of the optional max-budget-USD ceiling (empty = inherit). */
  maxBudget: string;
  /** Pending image attachments (in-memory base64 until the task is created). */
  attachments: PendingAttachment[];
  /** A validation error from the last add attempt (oversize / wrong type / limit). */
  attachError: string | null;
  busy: boolean;
  /** In-dialog error surfaced when `createTask` fails — keeps the dialog open. */
  error: string | null;
  canSubmit: boolean;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
  setKind: (value: TaskKind) => void;
  setRunMode: (value: RunMode) => void;
  setBranch: (value: string) => void;
  setBaseBranch: (value: string) => void;
  setPermissionMode: (value: PermissionMode | null) => void;
  setPlanFirst: (value: boolean) => void;
  setModel: (value: string | null) => void;
  setProviderId: (value: string | undefined) => void;
  setEffort: (value: string | null) => void;
  setMaxTurns: (value: string) => void;
  setMaxBudget: (value: string) => void;
  /** Validate + read image files into pending attachments (drop/paste/picker). */
  addFiles: (files: File[]) => void;
  /** Remove a pending attachment by its temp id. */
  removeAttachment: (tempId: string) => void;
  submit: () => Promise<void>;
  /** ⌘↵ / Ctrl+↵ in the description submits (Esc-to-close lives in the Modal). */
  onDescKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Paste-to-attach: image clipboard items become attachments; non-image paste is
   *  left alone so pasting text into the description still works. */
  onDescPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}

/** State, submit, and keyboard handling for the create-task dialog. */
export function useNewTaskForm({
  open,
  planGateDefault,
  onCreate,
  onClose,
}: NewTaskFormProps): NewTaskFormState {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<TaskKind>('build');
  const [runMode, setRunMode] = useState<RunMode>('main');
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const [planFirst, setPlanFirst] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [providerId, setProviderId] = useState<string | undefined>(undefined);
  const [effort, setEffort] = useState<string | null>(null);
  const [maxTurns, setMaxTurns] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // T6 (#147) — Fix 3: the plan-approval gate needs the provider's hooks capability
  // (the `canUseTool` channel that parks `ExitPlanMode`). Codex declares `plan` in its
  // autonomy levels but `supportsHooks: false` — a plan-mode run there surfaces no plan
  // and silently no-ops. Resolve the TASK's provider (its picked `providerId`, else the
  // default's capabilities) and gate the toggle on `supportsHooks`. Fail-open: `null`
  // capabilities (still loading / probe failed) ⇒ assume supported (Claude default).
  const capabilities = useProviderCapabilities();
  const resolvedCapabilities = capabilitiesForProvider(providerId, capabilities);
  const providerSupportsPlanGate = resolvedCapabilities?.supportsHooks ?? true;

  // Run-ceiling caveat (#296 item 5): the picked provider can't enforce maxTurns /
  // maxBudget (Codex's SDK has no turn/budget ceiling). Fail-open null while caps load.
  const runCeilingCaveat = runCeilingCaveatFor(resolvedCapabilities);

  // Governance mismatch warning (#296): whether the active project's Harness policy
  // is armed, loaded once below. `false` while loading — fail-open, a heads-up
  // ahead of the engine's own refusal, never the enforcement itself.
  const [harnessPolicyArmed, setHarnessPolicyArmed] = useState(false);
  const governanceWarning = governanceWarningFor(harnessPolicyArmed, resolvedCapabilities);

  // Load the project's branches once for the branch picker (worktree mode). Returns
  // [] outside Tauri; a failure just leaves free-form entry.
  useEffect(() => {
    let alive = true;
    void listBranches()
      .then((b) => {
        if (alive) setBranches(b);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Load the active project's Harness policy once (mirrors the branches load — a
  // project switch remounts this dialog's owner, so fetch-once stays current).
  useEffect(() => {
    let alive = true;
    void getHarnessPolicyFile()
      .then((policy) => {
        if (alive) {
          setHarnessPolicyArmed(
            policy.manifestExists && policy.enabled && harnessPolicyHasRules(policy),
          );
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // The dialog now stays mounted across close so its exit can animate — reset the
  // draft each time it opens, otherwise a cancelled draft would reappear on reopen.
  // (Branches are loaded data, not draft state, so they persist.)
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDescription('');
    setKind('build');
    setRunMode('main');
    setBranch('');
    setBaseBranch('');
    setPermissionMode(null);
    setModel(null);
    setProviderId(undefined);
    setEffort(null);
    setMaxTurns('');
    setMaxBudget('');
    setAttachments([]);
    setAttachError(null);
    setError(null);
  }, [open]);

  // Plan-approval gate (T6, #147): the "Plan first" toggle follows the kind + the
  // global default + the provider capability — a Build task defaults ON (when the gate
  // is on AND the provider supports the plan gate), other kinds / non-hooks providers
  // default OFF. Recomputed when the dialog (re)opens, the kind changes, or the picked
  // provider changes, so the sensible default tracks all three; a manual toggle after
  // that is preserved until one of them changes. Keyed on `open` too so a reopen
  // re-seeds even when nothing else changed. On a non-hooks provider this forces the
  // toggle OFF (and the .tsx makes it non-interactive), so a plan can never be forced
  // into a silent no-op.
  useEffect(() => {
    if (!open) return;
    setPlanFirst(planFirstDefault(kind, planGateDefault, providerSupportsPlanGate));
  }, [open, kind, planGateDefault, providerSupportsPlanGate]);

  const canSubmit = title.trim().length > 0 && !busy;

  const addFiles = useCallback(
    async (files: File[]) => {
      setAttachError(null);
      const { accepted, errors } = await readImageFiles(
        files,
        MAX_IMAGES_PER_TASK - attachments.length,
      );
      // Clamp inside the functional update: capacity is derived from the
      // closure-captured `attachments.length`, but two adds in one render (drop +
      // paste) would each pass their own budget check and could overshoot the cap.
      // Re-clamping against the live `prev` keeps the total at `MAX_IMAGES_PER_TASK`.
      if (accepted.length > 0)
        setAttachments((prev) => [...prev, ...accepted].slice(0, MAX_IMAGES_PER_TASK));
      if (errors.length > 0) setAttachError(errors.join(' '));
    },
    [attachments],
  );

  const removeAttachment = useCallback((tempId: string) => {
    setAttachError(null);
    setAttachments((prev) => prev.filter((a) => a.tempId !== tempId));
  }, []);

  const onDescPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = imageFilesFrom(e.clipboardData);
      if (files.length > 0) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const submit = useCallback(async () => {
    if (title.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(title.trim(), description.trim(), kind, runMode, {
        permissionMode,
        // T6 (#147): the resolved "Plan first" toggle. The Rust submit path lowers
        // `true` → plan mode; `false` runs straight through. Never send `true` for a
        // provider without the plan gate (Fix 3) — belt-and-suspenders against a
        // provider-switch timing race, on top of the seed effect forcing it OFF.
        planFirst: providerSupportsPlanGate ? planFirst : false,
        model,
        providerId,
        effort,
        // Empty/blank/invalid input ⇒ inherit (omit the override → null at the seam).
        maxTurns: parsePositiveInt(maxTurns),
        maxBudgetUsd: parsePositiveFloat(maxBudget),
        // Branch + base only apply in worktree mode; blank ⇒ inherit the defaults.
        branch: runMode === 'worktree' ? branch.trim() || null : null,
        baseBranch: runMode === 'worktree' ? baseBranch.trim() || null : null,
        attachments: attachments.map(toPayload),
      });
      onClose();
    } catch (err) {
      // Keep the dialog open and surface the failure in-dialog so the draft isn't
      // lost (the shell also raises a toast).
      setError(err instanceof Error ? err.message : 'Could not create the task.');
    } finally {
      setBusy(false);
    }
  }, [
    title,
    description,
    kind,
    runMode,
    branch,
    baseBranch,
    permissionMode,
    planFirst,
    providerSupportsPlanGate,
    model,
    providerId,
    effort,
    maxTurns,
    maxBudget,
    attachments,
    busy,
    onCreate,
    onClose,
  ]);

  const onDescKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // ⌘↵ / Ctrl+↵ submits; plain Esc-to-close is owned by the shared Modal.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  return {
    title,
    description,
    kind,
    runMode,
    branch,
    baseBranch,
    branches,
    permissionMode,
    planFirst,
    providerSupportsPlanGate,
    governanceWarning,
    runCeilingCaveat,
    model,
    providerId,
    effort,
    maxTurns,
    maxBudget,
    attachments,
    attachError,
    busy,
    error,
    canSubmit,
    setTitle,
    setDescription,
    setKind,
    setRunMode,
    setBranch,
    setBaseBranch,
    setPermissionMode,
    setPlanFirst,
    setModel,
    setProviderId,
    setEffort,
    setMaxTurns,
    setMaxBudget,
    addFiles,
    removeAttachment,
    submit,
    onDescKeyDown,
    onDescPaste,
  };
}
