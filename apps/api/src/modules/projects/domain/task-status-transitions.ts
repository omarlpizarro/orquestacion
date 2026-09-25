import { BlockReasonRequiredError } from './errors/block-reason-required.error.js';
import { InvalidTaskStatusTransitionError } from './errors/invalid-task-status-transition.error.js';
import { TaskStatusTransitionForbiddenError } from './errors/task-status-transition-forbidden.error.js';
import type { OrgRole, TaskStatus } from './task-status.js';

export type { OrgRole, TaskStatus } from './task-status.js';

const ALL_ROLES: readonly OrgRole[] = ['owner', 'director', 'manager', 'operator'];
const MANAGEMENT_ROLES: readonly OrgRole[] = ['owner', 'director', 'manager'];

export interface TaskStatusTransition {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly allowedRoles: readonly OrgRole[];
  /** Regla fija del brief: crea un `task_update` de tipo `block_report` en la misma transacción. */
  readonly requiresBlockReport: boolean;
  /** Regla fija del brief: `actual_end_at` se fija con la hora del servidor, nunca con la del cliente. */
  readonly setsActualEndAt: boolean;
}

/**
 * Tabla explícita de transiciones (CLAUDE.md §5: "nunca con un trigger de
 * base", este es el guard de aplicación). `done` y `cancelled` no aparecen
 * como `from` de ninguna fila: son terminales por omisión, no por un caso
 * especial en el código que las valide.
 *
 * El camino operativo (`pending → in_progress → {blocked, in_review, done}`,
 * con `blocked ⇄ in_progress`) lo ejecuta cualquier rol, incluido `operator`
 * sobre sus propias tareas asignadas — es el trabajo de campo que este
 * sistema existe para destrabar. Cancelar y resolver una revisión
 * (`in_review → in_progress` o `→ done`) quedan reservados a
 * `MANAGEMENT_ROLES`: cancelar es una decisión de negocio, no operativa, y
 * aprobar/rechazar una revisión requiere que alguien distinto de quien hizo
 * el trabajo la resuelva.
 */
export const TASK_STATUS_TRANSITIONS: readonly TaskStatusTransition[] = [
  {
    from: 'pending',
    to: 'in_progress',
    allowedRoles: ALL_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: false,
  },
  {
    from: 'pending',
    to: 'cancelled',
    allowedRoles: MANAGEMENT_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: false,
  },
  {
    from: 'in_progress',
    to: 'blocked',
    allowedRoles: ALL_ROLES,
    requiresBlockReport: true,
    setsActualEndAt: false,
  },
  {
    from: 'in_progress',
    to: 'in_review',
    allowedRoles: ALL_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: false,
  },
  {
    from: 'in_progress',
    to: 'done',
    allowedRoles: ALL_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: true,
  },
  {
    from: 'in_progress',
    to: 'cancelled',
    allowedRoles: MANAGEMENT_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: false,
  },
  {
    from: 'blocked',
    to: 'in_progress',
    allowedRoles: ALL_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: false,
  },
  {
    from: 'blocked',
    to: 'cancelled',
    allowedRoles: MANAGEMENT_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: false,
  },
  {
    from: 'in_review',
    to: 'in_progress',
    allowedRoles: MANAGEMENT_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: false,
  },
  {
    from: 'in_review',
    to: 'done',
    allowedRoles: MANAGEMENT_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: true,
  },
  {
    from: 'in_review',
    to: 'cancelled',
    allowedRoles: MANAGEMENT_ROLES,
    requiresBlockReport: false,
    setsActualEndAt: false,
  },
];

/** Regla fija del brief: `cancelled` queda fuera de los KPIs de cumplimiento. */
const COMPLIANCE_EXCLUDED_STATUSES: ReadonlySet<TaskStatus> = new Set(['cancelled']);

export function findTaskStatusTransition(
  from: TaskStatus,
  to: TaskStatus,
): TaskStatusTransition | undefined {
  return TASK_STATUS_TRANSITIONS.find(
    (transition) => transition.from === from && transition.to === to,
  );
}

/** `true` para `done` y `cancelled`: ninguna fila de la tabla los usa como `from`. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return !TASK_STATUS_TRANSITIONS.some((transition) => transition.from === status);
}

export function isExcludedFromComplianceKpis(status: TaskStatus): boolean {
  return COMPLIANCE_EXCLUDED_STATUSES.has(status);
}

export interface TaskStatusTransitionRequest {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly role: OrgRole;
  /** Motivo del bloqueo, contenido del `task_update` de tipo `block_report`. Solo se exige cuando `to === 'blocked'`. */
  readonly blockReason?: string | undefined;
}

/**
 * Valida una transición pedida y devuelve la definición para que el handler
 * (todavía no existe: PR siguiente, con endpoint) sepa qué efectos aplicar
 * — `requiresBlockReport`/`setsActualEndAt` son instrucciones para esa capa,
 * no algo que este módulo ejecute: dominio puro no toca la base ni el reloj.
 *
 * Orden de validación: primero si la transición existe (un error de dominio
 * de negocio, 422), después si el rol puede ejecutarla (403), y por último
 * si trae lo que esa transición exige (422 de nuevo). Chequear "existe" antes
 * que "quién puede" evita filtrar por temporización qué transiciones son
 * válidas a un rol que ni siquiera tendría permiso de intentarlas.
 */
export function resolveTaskStatusTransition(
  request: TaskStatusTransitionRequest,
): TaskStatusTransition {
  const transition = findTaskStatusTransition(request.from, request.to);
  if (!transition) {
    throw new InvalidTaskStatusTransitionError(request.from, request.to);
  }
  if (!transition.allowedRoles.includes(request.role)) {
    throw new TaskStatusTransitionForbiddenError(request.from, request.to, request.role);
  }
  if (transition.requiresBlockReport && !request.blockReason?.trim()) {
    throw new BlockReasonRequiredError();
  }
  return transition;
}
