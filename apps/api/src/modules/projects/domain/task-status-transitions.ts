import { InvalidTaskStatusTransitionError } from './errors/invalid-task-status-transition.error.js';
import { ReasonRequiredError } from './errors/reason-required.error.js';
import { TaskStatusTransitionForbiddenError } from './errors/task-status-transition-forbidden.error.js';
import { TaskStatusTransitionRequiresAssigneeError } from './errors/task-status-transition-requires-assignee.error.js';
import type { OrgRole, ReasonKind, TaskStatus } from './task-status.js';

export {
  type OrgRole,
  parseSingleOrgRole,
  type ReasonKind,
  type TaskStatus,
} from './task-status.js';

const ALL_ROLES: readonly OrgRole[] = ['owner', 'director', 'manager', 'operator'];
const MANAGEMENT_ROLES: readonly OrgRole[] = ['owner', 'director', 'manager'];

export interface TaskStatusTransition {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly allowedRoles: readonly OrgRole[];
  /**
   * `'block_report'` es la regla fija del brief: crea un `task_update` de
   * ese tipo en la misma transacción. `'reopen'` es la misma idea aplicada
   * a `done → in_progress` (ADR-012): reabrir una tarea cerrada es una
   * decisión de gerencia y tiene que dejar rastro del porqué. `null` cuando
   * la transición no exige justificarse.
   */
  readonly requiresReason: ReasonKind | null;
  /** Regla fija del brief: `actual_end_at` se fija con la hora del servidor, nunca con la del cliente. */
  readonly setsActualEndAt: boolean;
  /**
   * ADR-012: `done → in_progress` es la única transición que la limpia. Si
   * no se limpiara, la tarea reabierta quedaría con `actual_end_at` cargado
   * mientras sigue en curso, y el KPI de desviación de tiempo (RF-F2) la
   * contaría como terminada. Al completarse de nuevo, `actual_end_at` se
   * fija una vez más con la hora del servidor — el fin real es el último,
   * no el primero.
   */
  readonly clearsActualEndAt: boolean;
}

/**
 * Tabla explícita de transiciones (CLAUDE.md §5: "nunca con un trigger de
 * base", este es el guard de aplicación). Solo `cancelled` no aparece como
 * `from` de ninguna fila: es terminal por decisión de negocio, no por una
 * limitación técnica — ver ADR-012 sobre por qué `done` sí se puede
 * reabrir y `cancelled` no.
 *
 * El camino operativo (`pending → in_progress → {blocked, in_review, done}`,
 * con `blocked ⇄ in_progress`, y ahora `pending → blocked` directo para el
 * caso de campo más común: no se puede ni arrancar) lo ejecuta cualquier
 * rol — pero cuando ese rol es `operator`, solo sobre una tarea de la que
 * es asignado (`TaskStatusTransitionRequest.isAssignee`, CLAUDE.md §7: nivel
 * 3 es "sus tareas y su sitio", no cualquier tarea de la organización). El
 * scoping por sitio (`member_site_access`) para roles de gerencia queda
 * pendiente, documentado junto al resto de ese gap en
 * `docs/phase-2-brief.md`.
 *
 * Cancelar y resolver una revisión (`in_review → in_progress` o `→ done`)
 * quedan reservados a `MANAGEMENT_ROLES`: cancelar es una decisión de
 * negocio, no operativa, y aprobar/rechazar una revisión requiere que
 * alguien distinto de quien hizo el trabajo la resuelva. Reabrir una tarea
 * ya cerrada (`done → in_progress`) es la misma categoría de decisión.
 */
export const TASK_STATUS_TRANSITIONS: readonly TaskStatusTransition[] = [
  {
    from: 'pending',
    to: 'in_progress',
    allowedRoles: ALL_ROLES,
    requiresReason: null,
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'pending',
    to: 'blocked',
    allowedRoles: ALL_ROLES,
    requiresReason: 'block_report',
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'pending',
    to: 'cancelled',
    allowedRoles: MANAGEMENT_ROLES,
    requiresReason: null,
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'in_progress',
    to: 'blocked',
    allowedRoles: ALL_ROLES,
    requiresReason: 'block_report',
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'in_progress',
    to: 'in_review',
    allowedRoles: ALL_ROLES,
    requiresReason: null,
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'in_progress',
    to: 'done',
    allowedRoles: ALL_ROLES,
    requiresReason: null,
    setsActualEndAt: true,
    clearsActualEndAt: false,
  },
  {
    from: 'in_progress',
    to: 'cancelled',
    allowedRoles: MANAGEMENT_ROLES,
    requiresReason: null,
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'blocked',
    to: 'in_progress',
    allowedRoles: ALL_ROLES,
    requiresReason: null,
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'blocked',
    to: 'cancelled',
    allowedRoles: MANAGEMENT_ROLES,
    requiresReason: null,
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'in_review',
    to: 'in_progress',
    allowedRoles: MANAGEMENT_ROLES,
    requiresReason: null,
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'in_review',
    to: 'done',
    allowedRoles: MANAGEMENT_ROLES,
    requiresReason: null,
    setsActualEndAt: true,
    clearsActualEndAt: false,
  },
  {
    from: 'in_review',
    to: 'cancelled',
    allowedRoles: MANAGEMENT_ROLES,
    requiresReason: null,
    setsActualEndAt: false,
    clearsActualEndAt: false,
  },
  {
    from: 'done',
    to: 'in_progress',
    allowedRoles: MANAGEMENT_ROLES,
    requiresReason: 'reopen',
    setsActualEndAt: false,
    clearsActualEndAt: true,
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

/**
 * `true` solo para `cancelled` (ADR-012): ninguna fila de la tabla lo usa
 * como `from`. `done` no es terminal desde que existe `done → in_progress`.
 */
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
  /**
   * `true` cuando quien pide la transición es el `assignee_member_id` de la
   * tarea. Solo importa para `role === 'operator'` (CLAUDE.md §7): los
   * demás roles no están limitados a sus propias tareas. Quien arma esta
   * request (el handler futuro) es responsable de resolverlo contra la fila
   * real; el dominio no consulta la base.
   */
  readonly isAssignee?: boolean | undefined;
  /** Motivo exigido cuando `transition.requiresReason` no es `null` (ver ese campo). */
  readonly reason?: string | undefined;
}

export interface ResolvedTaskStatusTransition extends TaskStatusTransition {
  /**
   * El `reason` de la request, ya validado y sin espacios al borde —
   * `null` cuando `requiresReason` es `null`, string no vacío cuando no lo
   * es. Devolverlo resuelto (en vez de que el handler vuelva a leer
   * `request.reason` y confiar en que ya se validó) evita que el llamador
   * necesite un `as string` para convencer al compilador de algo que este
   * módulo ya comprobó, y evita guardar un motivo con espacios de sobra.
   */
  readonly reason: string | null;
}

/**
 * Valida una transición pedida y devuelve la definición, más el motivo ya
 * validado, para que el handler sepa qué efectos aplicar —
 * `requiresReason`/`setsActualEndAt`/`clearsActualEndAt`/`reason` son
 * instrucciones para esa capa, no algo que este módulo ejecute: dominio
 * puro no toca la base ni el reloj.
 *
 * Orden de validación: primero si la transición existe. No es una elección
 * arbitraria ni busca ocultarle la matriz a un rol sin permiso — de hecho no
 * la oculta, porque la matriz completa está documentada acá mismo, no es un
 * secreto de seguridad. Es estructural: `allowedRoles` es un campo de la
 * transición misma, así que no hay "rol permitido" que evaluar para un par
 * `(from, to)` que no está en la tabla. Recién con la transición en mano
 * tiene sentido preguntar por rol, después por asignación (para `operator`,
 * CLAUDE.md §7) y por último por el motivo, si esa transición lo exige.
 */
export function resolveTaskStatusTransition(
  request: TaskStatusTransitionRequest,
): ResolvedTaskStatusTransition {
  const transition = findTaskStatusTransition(request.from, request.to);
  if (!transition) {
    throw new InvalidTaskStatusTransitionError(request.from, request.to);
  }
  if (!transition.allowedRoles.includes(request.role)) {
    throw new TaskStatusTransitionForbiddenError(request.from, request.to, request.role);
  }
  if (request.role === 'operator' && !request.isAssignee) {
    throw new TaskStatusTransitionRequiresAssigneeError(request.from, request.to);
  }
  if (!transition.requiresReason) {
    return { ...transition, reason: null };
  }
  const reason = request.reason?.trim();
  if (!reason) {
    throw new ReasonRequiredError(transition.requiresReason);
  }
  return { ...transition, reason };
}
