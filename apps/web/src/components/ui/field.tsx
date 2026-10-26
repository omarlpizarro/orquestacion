import { CircleAlert } from 'lucide-react';
import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react';

/**
 * Campo de formulario (docs/design-guidelines.md §7.5): etiqueta SIEMPRE visible arriba, alto 48, radio 10,
 * borde de 1 px en `border-strong` (el único modo de ver un campo; `border` no cumple 3:1) y el error
 * debajo, en `danger`, con ícono y diciendo qué hacer, no qué falló por dentro.
 */
type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'className' | 'id' | 'children'> & {
  label: string;
  /** Una ayuda corta debajo del campo. */
  hint?: string | undefined;
  /** Qué hacer para arreglarlo ("Escribí tu correo"). Marca el campo como inválido. */
  error?: string | undefined;
};

const CONTROL =
  'w-full rounded-control border border-border-strong bg-surface px-16 text-body text-text placeholder:text-text-2 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-text-disabled';

export function Field({
  label,
  hint,
  error,
  'aria-describedby': describedBy,
  ...input
}: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described =
    [describedBy, hint ? hintId : undefined, error ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className="flex flex-col gap-8">
      <label htmlFor={id} className="text-secondary-medium text-text">
        {label}
      </label>
      <input
        {...input}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className={`min-h-control ${CONTROL}`}
      />
      {hint ? (
        <p id={hintId} className="text-secondary text-text-2">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="flex items-start gap-4 text-secondary text-danger">
          <CircleAlert aria-hidden className="mt-4 size-icon-chip shrink-0" strokeWidth={2} />
          {error}
        </p>
      ) : null}
    </div>
  );
}

type TextAreaFieldProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'className' | 'id' | 'children'
> & {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
};

/** Campo de varias líneas, con la misma etiqueta, ayuda y error que `Field` (guía §7.5). */
export function TextAreaField({
  label,
  hint,
  error,
  'aria-describedby': describedBy,
  rows = 4,
  ...input
}: TextAreaFieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const described =
    [describedBy, hint ? hintId : undefined, error ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className="flex flex-col gap-8">
      <label htmlFor={id} className="text-secondary-medium text-text">
        {label}
      </label>
      <textarea
        {...input}
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={described}
        className={`py-12 ${CONTROL}`}
      />
      {hint ? (
        <p id={hintId} className="text-secondary text-text-2">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="flex items-start gap-4 text-secondary text-danger">
          <CircleAlert aria-hidden className="mt-4 size-icon-chip shrink-0" strokeWidth={2} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
