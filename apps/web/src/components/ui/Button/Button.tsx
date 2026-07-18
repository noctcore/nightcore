/** The shared action button primitive. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { m } from '../motion';
import { Spinner } from '../Spinner';

/** Visual style of a {@link Button}. */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Props for {@link Button}; extends native button attributes, minus the handful
 *  of drag/animation handlers whose React DOM signatures clash with the motion
 *  component's pan/animation events (Button never uses them). */
interface ButtonProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    'onDrag' | 'onDragStart' | 'onDragEnd' | 'onAnimationStart' | 'onAnimationEnd'
  > {
  children: ReactNode;
  variant?: ButtonVariant;
  /** In-flight state: disables the button, sets `aria-busy`, and renders a
   *  leading spinner. Composes with `disabled` (either one inerts the button). */
  busy?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-primary text-primary-foreground enabled:hover:brightness-110',
  secondary:
    'border border-border text-foreground enabled:hover:bg-white/[0.05]',
  ghost: 'text-muted-foreground enabled:hover:text-foreground',
  danger: 'bg-destructive text-destructive-foreground enabled:hover:brightness-110',
};

/** The primary action button with shared pill geometry and consistent
 *  disabled/active affordances across every surface. Defaults to `type="button"`. */
export function Button({
  children,
  variant = 'primary',
  busy = false,
  className,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  const inert = disabled === true || busy;
  return (
    <m.button
      type={type}
      disabled={inert}
      aria-busy={busy || undefined}
      // Motion owns the press/hover transform (so `transform` is dropped from the
      // CSS `transition-[…]` list to avoid a double-animation); gestures are gated
      // off while inert so a disabled/busy button never lifts or scales.
      whileHover={inert ? undefined : { y: -1 }}
      whileTap={inert ? undefined : { scale: 0.97 }}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-nc px-4 py-1.5 text-sm font-semibold transition-[filter,background,border-color] disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className ?? ''}`}
      {...rest}
    >
      {busy && <Spinner size={14} />}
      {children}
    </m.button>
  );
}
