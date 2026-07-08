/** Barrel module re-exporting every shared UI primitive and its public types. */
export { Badge } from './Badge';
export { BranchPicker } from './BranchPicker';
export type { BranchPickerProps } from './BranchPicker/BranchPicker.types';
export { BrandMark } from './BrandMark';
export { Button } from './Button';
export { Card } from './Card';
export type {
  CategoryTabDescriptor,
  CategoryTabsShellProps,
} from './CategoryTabsShell';
export { CategoryTabsShell } from './CategoryTabsShell';
export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox/Checkbox.types';
export type { CodeBlockProps } from './CodeBlock';
export { CodeBlock } from './CodeBlock';
export { ConfirmDialog } from './ConfirmDialog';
export type { ConfirmDialogProps } from './ConfirmDialog/ConfirmDialog.types';
export type { DetailCardGridProps, DetailCardProps } from './DetailCardGrid';
export { DetailCard, DetailCardGrid } from './DetailCardGrid';
export type { DetailPanelShellProps } from './DetailPanelShell';
export { DetailLocation, DetailPanelShell, DetailSection } from './DetailPanelShell';
export { EmptyState } from './EmptyState';
export { FieldValue } from './FieldValue';
export type {
  GroundedFindingBodyProps,
  GroundedFindingSections,
  GroundedFindingView,
  GroundedLifecycleFooterProps,
} from './GroundedFindingBody';
export {
  GroundedFindingBody,
  GroundedLifecycleFooter,
  inferLanguageFromFile,
} from './GroundedFindingBody';
export { IconButton } from './IconButton';
export * from './icons';
export { IconTile } from './IconTile';
export type { ImageDropzoneItem, ImageDropzoneProps } from './ImageDropzone';
export { ImageDropzone } from './ImageDropzone';
export { Kbd } from './Kbd';
export type {
  LensChipDescriptor,
  LensChipGridProps,
  ScanConfigFormProps,
} from './LensChipGrid';
export { chipClass, LensChipGrid, ScanConfigForm } from './LensChipGrid';
export { Markdown } from './Markdown';
export type { MarkdownProps } from './Markdown/Markdown.types';
export { Menu } from './Menu';
export type { MenuItem, MenuProps } from './Menu/Menu.types';
export type { ModalProps } from './Modal';
export { Modal, useLastPresent, useModal } from './Modal';
/** @deprecated Migrated to `ModelSelectField` / `ModelSelect` (B5). This thin
 *  adapter re-exports the combobox picker for one deprecation cycle, then is
 *  deleted. Prefer `ModelSelectField` (live-wired) for new surfaces. */
export { ModelEffortPicker } from './ModelEffortPicker';
export type { ModelEffortPickerProps } from './ModelEffortPicker/ModelEffortPicker.types';
export type {
  ModelCatalogData,
  ModelCatalogState,
  ModelSelection,
  ModelSelectProps,
} from './ModelSelect';
export { ModelSelect, STATIC_MODEL_CATALOG_DATA, useModelCatalog } from './ModelSelect';
export type { ModelSelectFieldProps } from './ModelSelectField';
export {
  LIVE_MODEL_CATALOG_DATA,
  ModelSelectField,
  useProviderCapabilities,
  useShowCostLine,
} from './ModelSelectField';
export * from './motion';
export { NumberField } from './NumberField';
export type { NumberFieldProps } from './NumberField/NumberField.types';
export { Pill } from './Pill';
export type {
  KnownProviderId,
  ProviderGlyph,
  ProviderGlyphProps,
  ProviderIconProps,
} from './ProviderIcon';
export {
  getProviderIconForModel,
  inferProviderFromModel,
  knownProviderFrom,
  PROVIDER_GLYPHS,
  providerGlyphFor,
  ProviderIcon,
  providerLabel,
  resolveProviderForModel,
} from './ProviderIcon';
export { RepoLink } from './RepoLink';
export type { RunLifecycleShellProps, RunPhase } from './RunLifecycleShell';
export { RunLifecycleShell } from './RunLifecycleShell';
export type {
  CategoryRunState,
  RunProgressCategory,
  RunProgressProps,
  RunProgressStatus,
  RunProgressUsage,
} from './RunProgress';
export { RunProgress } from './RunProgress';
export { Segmented } from './Segmented';
export type { SegmentedProps } from './Segmented/Segmented.types';
export { Skeleton } from './Skeleton';
export { Spinner } from './Spinner';
export { StatusDot } from './StatusDot';
export type { Toast, ToastApi, ToastTone } from './Toast';
export { ToastProvider, useToast } from './Toast';
export { Toggle } from './Toggle';
export type { ToggleProps } from './Toggle/Toggle.types';
export type { ToolbarProps } from './Toolbar';
export { Toolbar } from './Toolbar';
export type { ToolbarOptionProps } from './ToolbarOption';
export { ToolbarOption } from './ToolbarOption';
