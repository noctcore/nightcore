import { Kbd } from '@/components/ui';

/** The sidebar-footer affordance that ADVERTISES the `?` cheatsheet. A hotkey nobody
 *  is told about is a hotkey nobody uses, so the key itself is the button: the chip
 *  reads `?`, and clicking it opens the same sheet the key does. Sits beside the
 *  version / GitHub row (passed in as `slots.help`, so the nav's prop contract stays
 *  inside its budget). */
export function ShortcutHintButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Keyboard shortcuts"
      title="Keyboard shortcuts (?)"
      className="flex cursor-pointer items-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-white/[0.08] hover:text-foreground"
    >
      <Kbd>?</Kbd>
    </button>
  );
}
