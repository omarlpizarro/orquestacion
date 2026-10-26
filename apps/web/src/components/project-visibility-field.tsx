import type { ProjectOutput } from '@orq/contracts';

export type ProjectVisibility = ProjectOutput['visibility'];

export const DEFAULT_PROJECT_VISIBILITY: ProjectVisibility = 'reserved';

/** Lo que mandó el formulario, a un valor válido: cualquier cosa rara cae en la opción más cerrada. */
export function parseVisibility(value: FormDataEntryValue | null): ProjectVisibility {
  return value === 'site' ? 'site' : DEFAULT_PROJECT_VISIBILITY;
}

const OPTIONS: ReadonlyArray<{ value: ProjectVisibility; label: string }> = [
  {
    value: 'reserved',
    label: 'Reservado: lo ven la dirección y quienes tengan tareas en él',
  },
  { value: 'site', label: 'Del sitio: lo ve todo el que trabaja en ese sitio' },
];

/**
 * Quién ve el proyecto (ADR-017). Dos opciones excluyentes, así que botones de opción en vez de un campo
 * de texto (docs/design-guidelines.md §7.5: selección antes que escritura). `reserved` va marcado por
 * defecto: es el valor más cerrado.
 */
export function ProjectVisibilityField({ disabled }: { disabled?: boolean | undefined }) {
  return (
    <fieldset className="flex flex-col gap-8">
      <legend className="text-secondary-medium text-text">Quién lo ve</legend>
      {OPTIONS.map((option) => (
        <label
          key={option.value}
          className="flex min-h-touch cursor-pointer items-center gap-12 text-body text-text"
        >
          <input
            type="radio"
            name="visibility"
            value={option.value}
            defaultChecked={option.value === DEFAULT_PROJECT_VISIBILITY}
            disabled={disabled}
            className="size-icon-button shrink-0 accent-primary"
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
