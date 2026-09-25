import type { TaskOutput } from '@orq/contracts';

export type TaskStatus = TaskOutput['status'];

/**
 * Los cuatro niveles de CLAUDE.md §7 que corresponden a un `member` real (el
 * nivel 4, invitado, nunca transiciona una tarea: entra por `guest_link` con
 * una proyección de solo lectura). Se define acá, no importando
 * `shared/auth/access-control.ts`, para que este módulo siga siendo dominio
 * puro sin depender del plugin de Better Auth — el mapeo entre esto y
 * `tenant.role` (string, potencialmente varios roles separados por coma) lo
 * hace `parseSingleOrgRole` más abajo.
 */
export type OrgRole = 'owner' | 'director' | 'manager' | 'operator';

/**
 * `tenant.role` puede traer varios roles separados por coma (Better Auth lo
 * permite). `hasCapability` (`shared/auth/access-control.ts`) autoriza ahí
 * si CUALQUIERA de los roles alcanza, porque esa es una capacidad gruesa
 * ("puede crear tareas sí/no") donde no importa cuál de los roles fue el
 * que autorizó. Acá sí importa: `resolveTaskStatusTransition` usa el rol
 * para dos cosas distintas (qué transiciones permite, y si el chequeo de
 * `isAssignee` aplica), así que "alcanza con que uno autorice" no tiene una
 * respuesta única cuando los roles no serían equivalentes para ambos
 * chequeos. En vez de elegir en silencio cuál usar (y que el resultado
 * dependa del orden en que llegaron), esto falla fuerte: un miembro real
 * con más de un rol es un caso que hay que decidir explícitamente, no
 * adivinar.
 */
export function parseSingleOrgRole(roleString: string): OrgRole {
  const roles = [...new Set(roleString.split(',').map((role) => role.trim()))];
  if (roles.length !== 1) {
    throw new Error(
      `Se esperaba un solo rol para evaluar la máquina de estados, se recibió "${roleString}". ` +
        'hasCapability sí soporta varios roles separados por coma para capacidades gruesas; acá ' +
        'no hay una forma segura de "alcanza con que uno autorice" (ver el comentario de OrgRole).',
    );
  }
  return roles[0] as OrgRole;
}

/**
 * Motivo que una transición puede exigir de quien la pide (ver
 * `TaskStatusTransition.requiresReason`). Es un concepto de dominio —
 * "esta transición necesita que alguien explique por qué" — independiente
 * de cómo lo persiste el handler: `'block_report'` y `'reopen'` son valores
 * reales de `task_update.kind` (`0006_collaboration.sql` y
 * `0007_task_update_reopen_kind.sql`).
 */
export type ReasonKind = 'block_report' | 'reopen';
