import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * Botones de docs/design-guidelines.md §7.1. Alto 48 (los de ícono, 44 × 44), radio 10, texto 16/600.
 * Una sola acción principal por pantalla (§6). No acepta `className`: el aspecto sale de la variante
 * y de los tokens; el espacio alrededor lo pone quien lo usa, con un contenedor.
 */
type NativeProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>;

export type TextButtonProps = NativeProps & {
  variant?: 'primary' | 'secondary' | 'destructive';
  /** En móvil la acción principal ocupa el ancho completo. */
  fullWidth?: boolean;
  children: ReactNode;
};

/** Un botón de ícono sin `aria-label` no se puede escribir (guía §7.1 y §10). */
export type IconButtonProps = NativeProps & {
  variant: 'icon';
  'aria-label': string;
  children: ReactNode;
};

export type ButtonProps = TextButtonProps | IconButtonProps;

const BASE =
  'inline-flex items-center justify-center gap-8 rounded-control text-button transition-colors disabled:cursor-not-allowed';

// Deshabilitado: `text-disabled` sobre `surface-2`, sin borde. `enabled:` en hover/active para que un
// botón deshabilitado no responda al puntero.
const DISABLED = 'disabled:border-transparent disabled:bg-surface-2 disabled:text-text-disabled';

// Clases escritas completas, no armadas con plantillas: Tailwind solo genera las que ve en el código.
const VARIANTS = {
  primary: `min-h-control px-16 bg-primary text-on-primary enabled:hover:bg-primary-pressed enabled:active:bg-primary-pressed ${DISABLED}`,
  secondary: `min-h-control px-16 border border-border bg-surface text-text enabled:hover:bg-surface-2 enabled:active:bg-surface-2 ${DISABLED}`,
  destructive: `min-h-control px-16 bg-danger text-on-danger ${DISABLED}`,
  icon: `size-touch border border-border bg-transparent text-text-2 enabled:hover:bg-surface-2 enabled:active:bg-surface-2 ${DISABLED}`,
} as const;

export function Button(props: ButtonProps) {
  // `type="button"` por defecto: un botón dentro de un formulario no envía sin querer.
  if (props.variant === 'icon') {
    const { variant: _variant, type = 'button', children, ...rest } = props;
    return (
      <button type={type} {...rest} className={`${BASE} ${VARIANTS.icon}`}>
        {children}
      </button>
    );
  }
  const { variant = 'primary', fullWidth = false, type = 'button', children, ...rest } = props;
  return (
    <button
      type={type}
      {...rest}
      className={`${BASE} ${VARIANTS[variant]}${fullWidth ? ' w-full' : ''}`}
    >
      {children}
    </button>
  );
}
