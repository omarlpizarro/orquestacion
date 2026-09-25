import type { TaskOutput } from '@orq/contracts';

export type TaskStatus = TaskOutput['status'];

/**
 * Los cuatro niveles de CLAUDE.md §7 que corresponden a un `member` real (el
 * nivel 4, invitado, nunca transiciona una tarea: entra por `guest_link` con
 * una proyección de solo lectura). Se define acá, no importando
 * `shared/auth/access-control.ts`, para que este módulo siga siendo dominio
 * puro sin depender del plugin de Better Auth — el mapeo entre esto y
 * `tenant.role` (string, potencialmente varios roles separados por coma) es
 * responsabilidad del handler que todavía no existe (PR siguiente).
 */
export type OrgRole = 'owner' | 'director' | 'manager' | 'operator';

/**
 * Motivo que una transición puede exigir de quien la pide (ver
 * `TaskStatusTransition.requiresReason`). Es un concepto de dominio —
 * "esta transición necesita que alguien explique por qué" — independiente
 * de cómo lo persista el handler futuro: `'block_report'` today coincide
 * con un valor real de `task_update.kind` (0005_projects.sql), pero
 * `'reopen'` no tiene todavía una fila que lo represente — esa decisión de
 * persistencia queda para cuando exista el handler.
 */
export type ReasonKind = 'block_report' | 'reopen';
