/** The shared action button primitive. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { m } from '../motion';

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
  className,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <m.button
      type={type}
      disabled={disabled}
      // Motion owns the press/hover transform (so `transform` is dropped from the
      // CSS `transition-[…]` list to avoid a double-animation); gestures are gated
      // off while disabled so an inert button never lifts or scales.
      whileHover={disabled === true ? undefined : { y: -1 }}
      whileTap={disabled === true ? undefined : { scale: 0.97 }}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-4 py-1.5 text-sm font-semibold transition-[filter,background,border-color] disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className ?? ''}`}
      {...rest}
    >
      {children}
    </m.button>
  );
}
