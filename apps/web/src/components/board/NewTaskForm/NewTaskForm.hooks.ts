import { useCallback, useState } from 'react';
import type { PermissionMode, RunMode, TaskKind } from '@/lib/bridge';
import type { NewTaskFormProps } from './NewTaskForm.types';

/** Parse a positive-integer ceiling from free text; `null` for blank/invalid
 *  input (⇒ inherit the resolved default). */
function parsePositiveInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Parse a non-negative float ceiling from free text; `null` for blank/invalid. */
function parseNonNegativeFloat(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface NewTaskFormState {
  title: string;
  description: string;
  kind: TaskKind;
  runMode: RunMode;
  permissionMode: PermissionMode | null;
  model: string | null;
  effort: string | null;
  /** Raw text of the optional max-turns ceiling (empty = inherit). */
  maxTurns: string;
  /** Raw text of the optional max-budget-USD ceiling (empty = inherit). */
  maxBudget: string;
  busy: boolean;
  /** In-dialog error surfaced when `createTask` fails — keeps the dialog open. */
  error: string | null;
  canSubmit: boolean;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
  setKind: (value: TaskKind) => void;
  setRunMode: (value: RunMode) => void;
  setPermissionMode: (value: PermissionMode | null) => void;
  setModel: (value: string | null) => void;
  setEffort: (value: string | null) => void;
  setMaxTurns: (value: string) => void;
  setMaxBudget: (value: string) => void;
  submit: () => Promise<void>;
  /** ⌘↵ / Ctrl+↵ in the description submits (Esc-to-close lives in the Modal). */
  onDescKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/** State, submit, and keyboard handling for the create-task dialog. */
export function useNewTaskForm({
  onCreate,
  onClose,
}: NewTaskFormProps): NewTaskFormState {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<TaskKind>('build');
  const [runMode, setRunMode] = useState<RunMode>('main');
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [maxTurns, setMaxTurns] = useState('');
  const [maxBudget, setMaxBudget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = title.trim().length > 0 && !busy;

  const submit = useCallback(async () => {
    if (title.trim().length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(title.trim(), description.trim(), kind, runMode, {
        permissionMode,
        model,
        effort,
        // Empty/blank/invalid input ⇒ inherit (omit the override → null at the seam).
        maxTurns: parsePositiveInt(maxTurns),
        maxBudgetUsd: parseNonNegativeFloat(maxBudget),
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
    permissionMode,
    model,
    effort,
    maxTurns,
    maxBudget,
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
    permissionMode,
    model,
    effort,
    maxTurns,
    maxBudget,
    busy,
    error,
    canSubmit,
    setTitle,
    setDescription,
    setKind,
    setRunMode,
    setPermissionMode,
    setModel,
    setEffort,
    setMaxTurns,
    setMaxBudget,
    submit,
    onDescKeyDown,
  };
}
