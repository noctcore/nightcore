/** Square icon-only button with a required accessible name. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { m } from '../motion';
import { Tooltip } from '../Tooltip';

/** Props for {@link IconButton}; extends native button attributes (minus the
 *  drag/animation handlers whose React DOM signatures clash with the motion
 *  component's pan/animation events), so callers can pass `disabled`, `aria-*`,
 *  etc. through to the underlying button. */
interface IconButtonProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd'
  > {
  children: ReactNode;
  /** Required accessible name — icon buttons have no text content. */
  label: string;
}

/** A square, muted icon-only button with an accessible name. Lifts on hover and
 *  presses in on tap (transform-only via motion); gestures and hover are gated
 *  off while disabled so an inert button never lifts, scales, or highlights. The
 *  label doubles as a styled {@link Tooltip} (replacing the native `title`) while
 *  staying the button's `aria-label`. */
export function IconButton({
  children,
  label,
  className,
  disabled,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <Tooltip label={label} className="shrink-0">
      <m.button
        type={type}
        disabled={disabled}
        aria-label={label}
        whileHover={disabled === true ? undefined : { y: -1 }}
        whileTap={disabled === true ? undefined : { scale: 0.94 }}
        className={`flex shrink-0 items-center justify-center rounded-md p-1 text-muted-foreground transition-colors enabled:hover:bg-white/[0.08] enabled:hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 ${className ?? ''}`}
        {...rest}
      >
        {children}
      </m.button>
    </Tooltip>
  );
}
