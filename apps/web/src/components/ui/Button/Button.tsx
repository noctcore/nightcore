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
  primary: 'bg-primary text-primary-foreground',
  secondary: 'border border-border text-foreground',
  ghost: 'text-muted-foreground',
  danger: 'bg-destructive text-destructive-foreground',
};

/** The hover affordance per variant, applied only while the button is live —
 *  gated off (not via the `enabled:` pseudo) so it also neutralizes on an
 *  `aria-disabled` button, which is kept focusable and never natively disabled. */
const VARIANT_HOVER: Record<ButtonVariant, string> = {
  primary: 'hover:brightness-110',
  secondary: 'hover:bg-white/[0.05]',
  ghost: 'hover:text-foreground',
  danger: 'hover:brightness-110',
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
  // An `aria-disabled` button stays focusable (never natively `disabled`) but is
  // semantically inert — its gestures and hover affordance gate off just like a
  // real disabled/busy button, so it never lifts, scales, or hover-tints.
  const gesturesOff = inert || rest['aria-disabled'] === true;
  return (
    <m.button
      type={type}
      disabled={inert}
      aria-busy={busy || undefined}
      // Motion owns the press/hover transform (so `transform` is dropped from the
      // CSS `transition-[…]` list to avoid a double-animation); gestures are gated
      // off while inert/aria-disabled so such a button never lifts or scales.
      whileHover={gesturesOff ? undefined : { y: -1 }}
      whileTap={gesturesOff ? undefined : { scale: 0.97 }}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-nc px-4 py-1.5 text-sm font-semibold transition-[filter,background,border-color] disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${gesturesOff ? '' : VARIANT_HOVER[variant]} ${className ?? ''}`}
      {...rest}
    >
      {busy && <Spinner size={14} />}
      {children}
    </m.button>
  );
}
