/** Props for {@link IconPicker}. */
export interface IconPickerProps {
  selectedIcon: string | null;
  onSelectIcon: (icon: string | null) => void;
}
