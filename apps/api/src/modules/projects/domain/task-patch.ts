/**
 * Edición parcial de una tarea (`update-task`): qué campos cambian de verdad.
 *
 * Los valores ya vienen normalizados por quien llama: las fechas como instantes UTC
 * (el handler las convierte desde la hora de pared del sitio, ADR-008) y el texto
 * recortado. `undefined` = "no vino en el pedido"; `null` = "borrar el valor".
 */
export type TaskCriticality = 'low' | 'normal' | 'high' | 'critical';

export interface EditableTaskFields {
  title: string;
  description: string | null;
  criticality: TaskCriticality;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
}

export type TaskPatch = {
  [Field in keyof EditableTaskFields]?: EditableTaskFields[Field] | undefined;
};

export interface TaskPatchResult {
  /** Solo los campos que cambian de verdad, con su valor nuevo. */
  changes: Partial<EditableTaskFields>;
  /** Los mismos campos, para el evento de dominio. */
  changedFields: Array<keyof EditableTaskFields>;
  /** Las fechas nuevas dejan el fin antes del inicio. */
  datesIncoherent: boolean;
}

/**
 * Estados en los que la tarea no se edita. Solo `cancelled`: es terminal, cancelar no
 * tiene vuelta atrás (ADR-012). Una tarea `done` sí se edita, porque se puede reabrir.
 */
const FROZEN_FOR_EDIT: readonly string[] = ['cancelled'];

export function isTaskFrozenForEdit(status: string): boolean {
  return FROZEN_FOR_EDIT.includes(status);
}

/**
 * El fin planificado no puede ser anterior al inicio (`task_dates_coherent_check` en
 * la base). Con una sola de las dos fechas no hay con qué comparar. Fechas como
 * instantes UTC.
 */
export function plannedDatesAreCoherent(start: string | null, end: string | null): boolean {
  if (start === null || end === null) return true;
  return Date.parse(end) >= Date.parse(start);
}

const sameInstant = (a: string | null, b: string | null): boolean =>
  a === b || (a !== null && b !== null && Date.parse(a) === Date.parse(b));

/** Un texto vacío (o solo espacios) y `null` son lo mismo: "sin descripción". */
function normalizeDescription(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Compara el pedido con la tarea y deja solo lo que cambia. Un pedido que repite lo
 * que ya hay no cambia nada: el handler no escribe, así no se bumpea la versión ni se
 * deja una entrada vacía en el audit. Las fechas se comparan como instantes (la
 * misma hora escrita distinto es la misma).
 */
export function diffTaskPatch(current: EditableTaskFields, patch: TaskPatch): TaskPatchResult {
  const changes: Partial<EditableTaskFields> = {};

  if (patch.title !== undefined && patch.title !== current.title) {
    changes.title = patch.title;
  }
  if (patch.description !== undefined) {
    const next = normalizeDescription(patch.description);
    if (next !== current.description) changes.description = next;
  }
  if (patch.criticality !== undefined && patch.criticality !== current.criticality) {
    changes.criticality = patch.criticality;
  }
  if (
    patch.plannedStartAt !== undefined &&
    !sameInstant(patch.plannedStartAt, current.plannedStartAt)
  ) {
    changes.plannedStartAt = patch.plannedStartAt;
  }
  if (patch.plannedEndAt !== undefined && !sameInstant(patch.plannedEndAt, current.plannedEndAt)) {
    changes.plannedEndAt = patch.plannedEndAt;
  }

  const start = 'plannedStartAt' in changes ? changes.plannedStartAt : current.plannedStartAt;
  const end = 'plannedEndAt' in changes ? changes.plannedEndAt : current.plannedEndAt;
  const datesChange = 'plannedStartAt' in changes || 'plannedEndAt' in changes;
  const datesIncoherent = datesChange && !plannedDatesAreCoherent(start ?? null, end ?? null);

  return {
    changes,
    changedFields: Object.keys(changes) as Array<keyof EditableTaskFields>,
    datesIncoherent,
  };
}
