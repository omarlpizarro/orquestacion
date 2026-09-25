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
