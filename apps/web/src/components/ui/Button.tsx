/** The shared action button primitive. */
import type { ButtonHTMLAttributes, ReactNode } from 'react';

/** Visual style of a {@link Button}. */
type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

/** Props for {@link Button}; extends native button attributes. */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
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
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-[9px] px-4 py-1.5 text-sm font-semibold transition-[filter,background,border-color,transform] active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 ${VARIANTS[variant]} ${className ?? ''}`}
      {...rest}
    >
      {children}
    </button>
  );
}
