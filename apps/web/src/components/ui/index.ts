/** Barrel module re-exporting every shared UI primitive and its public types. */
export { Badge } from './Badge';
export type { BadgeProps, BadgeTone } from './Badge/Badge.types';
export { BranchPicker } from './BranchPicker';
export type { BranchPickerProps } from './BranchPicker/BranchPicker.types';
export { BrandMark } from './BrandMark';
export type {
  BulkConvertBarProps,
  BulkConvertProgressLike,
} from './BulkConvertBar';
export { BulkConvertBar } from './BulkConvertBar';
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
export { ConfirmHint } from './ConfirmHint';
export type { DetailCardGridProps, DetailCardProps } from './DetailCardGrid';
export { DetailCard, DetailCardGrid, GridFullRow } from './DetailCardGrid';
export type { DetailPanelShellProps } from './DetailPanelShell';
export { DetailLocation, DetailPanelShell, DetailSection } from './DetailPanelShell';
export { EditProjectDialog } from './EditProjectDialog';
export type {
  EditProjectDialogProps,
  EditProjectSaveArgs,
} from './EditProjectDialog/EditProjectDialog.types';
export { EmptyState } from './EmptyState';
export { FieldValue } from './FieldValue';
export { FolderBrowserDialog } from './FolderBrowserDialog';
export type { FolderBrowserDialogProps } from './FolderBrowserDialog/FolderBrowserDialog.types';
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
export { IconPicker } from './IconPicker';
export type { IconPickerProps } from './IconPicker/IconPicker.types';
export * from './icons';
export { IconTile } from './IconTile';
export type { ImageDropzoneItem, ImageDropzoneProps } from './ImageDropzone';
export { ImageDropzone } from './ImageDropzone';
export type { IssueMapDialogProps } from './IssueMapDialog';
export { IssueMapDialog } from './IssueMapDialog';
export type { IssueMapExportButtonProps } from './IssueMapExportButton';
export { IssueMapExportButton } from './IssueMapExportButton';
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
export { Modal, useLastPresent, useModal } from './Modal';
export type { ModalProps } from './Modal/Modal.types';
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
export { ModelSelect, useModelCatalog } from './ModelSelect';
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
export type { PortableLockExportButtonProps } from './PortableLockExportButton';
export { PortableLockExportButton } from './PortableLockExportButton';
export { ProjectContextMenu } from './ProjectContextMenu';
export type { ProjectContextMenuProps } from './ProjectContextMenu/ProjectContextMenu.types';
export { ProjectIcon } from './ProjectIcon';
export type { ProjectIconProps } from './ProjectIcon/ProjectIcon.types';
export { ProjectIconEditor } from './ProjectIconEditor';
export type {
  ProjectIconEditorProps,
  ProjectIconImageDraft,
} from './ProjectIconEditor/ProjectIconEditor.types';
export type { ProjectPathLabelProps } from './ProjectPathLabel';
export {
  compactProjectPath,
  friendlyProjectPath,
  ProjectPathLabel,
} from './ProjectPathLabel';
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
  RunProgressCategoryRound,
  RunProgressProps,
  RunProgressStatus,
  RunProgressUsage,
} from './RunProgress';
export { RunProgress } from './RunProgress';
export { RunUsageLine } from './RunUsageLine';
export { ScanModeToggle, type ScanModeToggleProps } from './ScanModeToggle';
export { SECTION_LABEL_CLASS, SectionLabel } from './SectionLabel';
export { Segmented } from './Segmented';
export type { SegmentedProps } from './Segmented/Segmented.types';
export { Skeleton } from './Skeleton';
export { Spinner } from './Spinner';
export { StatusDot } from './StatusDot';
export type { FieldLabelProps, TextFieldProps } from './TextField';
export { FIELD_INPUT_CLASS, FieldLabel, TextField } from './TextField';
export type { Toast, ToastApi, ToastTone } from './Toast';
export { ToastProvider, useToast } from './Toast';
export { Toggle } from './Toggle';
export type { ToggleProps } from './Toggle/Toggle.types';
export { Toolbar } from './Toolbar';
export type { ToolbarProps } from './Toolbar/Toolbar.types';
export type { ToolbarOptionProps } from './ToolbarOption';
export { ToolbarOption } from './ToolbarOption';
export type { TooltipProps } from './Tooltip';
export { Tooltip } from './Tooltip';
export { UsageLimitBanner } from './UsageLimitBanner';
