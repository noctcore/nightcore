import {
  LIVE_MODEL_CATALOG_DATA,
  ModelSelect,
  useModelCatalog,
} from '@/components/ui';
import {
  codexStaticModelDescriptors,
  effortOptionsForModel,
} from '@/lib/models';

export const PROVIDERS: [value: string, label: string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];

export function defaultModelForProvider(provider: string): string {
  return provider === 'codex' ? 'gpt-5-codex' : 'claude-opus-4-8';
}

export function effortChoices(model: string): [value: string, label: string][] {
  return effortOptionsForModel(model)
    .filter((e) => e.id !== 'none')
    .map((e) => [e.id, e.label]);
}

export function highestEffortFor(model: string): string {
  const choices = effortChoices(model);
  return choices.at(-1)?.[0] ?? 'high';
}

export function DefaultModelControl({
  provider,
  value,
  onPick,
}: {
  provider: string;
  value: string;
  onPick: (m: string) => void;
}) {
  const liveCatalog = useModelCatalog(LIVE_MODEL_CATALOG_DATA);
  const catalog =
    provider === 'codex'
      ? { status: 'ready' as const, models: codexStaticModelDescriptors() }
      : liveCatalog;
  return (
    <ModelSelect
      ariaLabel="Default model"
      showEffort={false}
      catalog={catalog}
      value={{ model: value, effort: null }}
      onChange={(sel) => sel.model !== null && onPick(sel.model)}
    />
  );
}
