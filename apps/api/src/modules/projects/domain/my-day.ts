import type { MyDaySection } from '@orq/contracts';
import type { LocalDayWindow } from './local-day-window.js';

/**
 * Solo los campos que este archivo necesita, no `TaskRow` — el dominio no
 * puede importar de `infrastructure/` (dependency-cruiser, `domain-is-pure`).
 * `TaskRow` cumple esta forma estructuralmente, así que el caller
 * (`my-day.handler.ts`) le pasa la fila del repositorio tal cual, sin mapeo.
 */
export interface MyDayTaskFields {
  status: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
}

/** Orden de despliegue de las secciones (docs/phase-2-brief.md, "Mi Día"). */
export const MY_DAY_SECTION_ORDER: readonly MyDaySection[] = [
  'overdue',
  'today',
  'blocked',
  'undated',
];

const CRITICALITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export interface MyDayClassification {
  section: MyDaySection;
  isOverdue: boolean;
}

function touchesDay(
  plannedStartAt: string | null,
  plannedEndAt: string | null,
  window: LocalDayWindow,
): boolean {
  // Si falta un extremo, la ventana es un punto en el otro (una tarea con
  // solo `planned_end_at` toca el día de su vencimiento; con solo
  // `planned_start_at`, el día en que arranca).
  const effectiveStart = plannedStartAt ?? plannedEndAt;
  const effectiveEnd = plannedEndAt ?? plannedStartAt;
  if (effectiveStart === null || effectiveEnd === null) return false;
  return effectiveStart < window.endUtc && effectiveEnd >= window.startUtc;
}

/**
 * Prioridad de clasificación, decidida junto con la definición de "Mi Día"
 * (docs/phase-2-brief.md): `blocked` > `overdue` > `today` > `undated`. Una
 * tarea vencida y bloqueada a la vez cae en `blocked`, pero `isOverdue`
 * sigue en `true` para no perder ese dato.
 *
 * Asume que `task` ya pasó el `WHERE` de `findMyDayTaskRows` (organización,
 * assignee, no `done`/`cancelled`, no borrada, y alguna de las condiciones
 * de abajo) — si le llega algo que no cumple ninguna, es que el repositorio
 * y este archivo se desincronizaron, y falla fuerte en vez de clasificar
 * mal en silencio.
 */
export function classifyMyDayTask(
  task: MyDayTaskFields,
  params: { nowUtc: string; dayWindow: LocalDayWindow },
): MyDayClassification {
  const isOverdue = task.plannedEndAt !== null && task.plannedEndAt < params.nowUtc;
  const hasNoDates = task.plannedStartAt === null && task.plannedEndAt === null;

  if (task.status === 'blocked') return { section: 'blocked', isOverdue };
  if (isOverdue) return { section: 'overdue', isOverdue };
  // in_progress sin ninguna fecha: se está trabajando ahora mismo, entra en
  // "hoy" aunque nunca se haya agendado.
  if (task.status === 'in_progress' && hasNoDates) return { section: 'today', isOverdue };
  if (touchesDay(task.plannedStartAt, task.plannedEndAt, params.dayWindow)) {
    return { section: 'today', isOverdue };
  }
  // pending sin ninguna fecha: nunca se agendó, sección propia al final.
  if (task.status === 'pending' && hasNoDates) return { section: 'undated', isOverdue };

  throw new Error(
    'classifyMyDayTask recibió una tarea que no debería haber pasado el WHERE de ' +
      'findMyDayTaskRows (ni vencida, ni bloqueada, ni toca "hoy", ni es un caso sin fecha) — ' +
      'el repositorio y este archivo se desincronizaron.',
  );
}

function criticalityRank(criticality: string): number {
  return (CRITICALITY_RANK[criticality] ?? CRITICALITY_RANK.normal) as number;
}

/** `null` (sin fecha) siempre al final, sin importar la dirección de la comparación. */
function compareNullsLast(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

export interface MyDaySortableFields {
  criticality: string;
  plannedStartAt: string | null;
  plannedEndAt: string | null;
  createdAt: string;
}

export type MyDaySortableTask = MyDaySortableFields & MyDayClassification;

/**
 * Orden decidido junto con la definición de "Mi Día":
 * - `overdue`: criticidad descendente, después `planned_end_at`.
 * - `today`: `planned_start_at`, nulls last (sin criterio de desempate
 *   explícito — `Array.prototype.sort` es estable en Node/V8, así que un
 *   empate conserva el orden que trajo la consulta).
 * - `blocked`/`undated`: sin pedido explícito. Se les aplica el mismo
 *   criterio que a `overdue` (criticidad, después fecha) para no inventar
 *   un tercer criterio sin necesidad — `undated` no tiene `planned_end_at`,
 *   así que cae en `created_at` como desempate.
 */
export function sortMyDayTasks<T extends MyDaySortableTask>(tasks: readonly T[]): T[] {
  return [...tasks].sort((a, b) => {
    const sectionDiff =
      MY_DAY_SECTION_ORDER.indexOf(a.section) - MY_DAY_SECTION_ORDER.indexOf(b.section);
    if (sectionDiff !== 0) return sectionDiff;

    switch (a.section) {
      case 'overdue':
      case 'blocked':
        return (
          criticalityRank(a.criticality) - criticalityRank(b.criticality) ||
          compareNullsLast(a.plannedEndAt, b.plannedEndAt)
        );
      case 'today':
        return compareNullsLast(a.plannedStartAt, b.plannedStartAt);
      case 'undated':
        return (
          criticalityRank(a.criticality) - criticalityRank(b.criticality) ||
          compareNullsLast(a.createdAt, b.createdAt)
        );
      default:
        // Inalcanzable mientras MyDaySection tenga estos cuatro valores —
        // explícito para que el linter (`useIterableCallbackReturn`) vea que
        // el callback de `sort` siempre devuelve algo, no por necesidad real.
        throw new Error(`sortMyDayTasks: sección desconocida "${a.section}".`);
    }
  });
}
