/** The shared right-edge detail sheet shell for a single finding/convention/
 *  reading: a focus-trapped {@link Modal} with the standard slide-in panel, a
 *  header (optional lead + badge column + close), a scrollable body, and a footer
 *  action row. Features compose their own badges, body sections, and footer. */
import type { ReactNode } from 'react';

import { IconButton } from '../IconButton';
import { CloseIcon } from '../icons';
import { Modal } from '../Modal';
import { slideIn } from '../motion';
import { SECTION_LABEL_CLASS } from '../SectionLabel';
import type { DetailPanelShellProps } from './DetailPanelShell.types';

export function DetailPanelShell({
  open,
  label,
  onClose,
  headerLead,
  badges,
  title,
  children,
  footer,
  wide = false,
}: DetailPanelShellProps) {
  return (
    <Modal
      open={open}
      label={label}
      onClose={onClose}
      overlayClassName="fixed inset-0 z-20 flex justify-end bg-black/60 backdrop-blur-sm"
      variant="sheet"
      panelClassName={wide ? 'max-w-2xl' : 'max-w-lg'}
      panelVariants={slideIn}
    >
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border px-5 py-4">
        {headerLead}
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">{badges}</div>
          <h2 className="text-[15px] font-semibold leading-snug text-foreground">
            {title}
          </h2>
        </div>
        <IconButton label="Close" onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
      </div>

      {/* Body */}
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
        {children}
      </div>

      {/* Footer actions */}
      <div className="flex items-center gap-2 border-t border-border px-5 py-4">
        {footer}
      </div>
    </Modal>
  );
}

/** A titled section inside a {@link DetailPanelShell} body. */
export function DetailSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className={SECTION_LABEL_CLASS}>{title}</h4>
      {children}
    </section>
  );
}

/** A grounded `file:line` location rendered as a bordered code chip. */
export function DetailLocation({ children }: { children: ReactNode }) {
  return (
    <code className="break-all rounded-md border border-border bg-white/[0.03] px-2 py-1 font-mono text-2xs-plus text-foreground">
      {children}
    </code>
  );
}
