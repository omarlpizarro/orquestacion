/**
 * Los cuatro niveles de CLAUDE.md §7 que corresponden a un `member` real (el
 * nivel 4, invitado, nunca transiciona una tarea: entra por `guest_link` con
 * una proyección de solo lectura). Vive en `shared/auth`, no en un módulo de
 * negocio: es un concepto de identidad (quién es, qué rol tiene en la
 * organización), no de `projects` — antes vivía en
 * `modules/projects/domain/task-status.ts` solo porque `projects` fue el
 * primer módulo que lo necesitó. El primer slice de otro módulo que también
 * necesite el rol de un member (reservas, fase 3) lo importa desde acá en
 * vez de cruzar la frontera de `projects`, que `dependency-cruiser`
 * (`no-cross-module-internals`) rechazaría.
 *
 * Sin dependencias de Better Auth ni de Nest a propósito: `domain/` de
 * cualquier módulo puede importar este archivo sin dejar de ser dominio
 * puro. `access-control.ts`, en el mismo directorio, sí envuelve el plugin
 * de Better Auth — por eso `OrgRole`/`parseSingleOrgRole` están en un
 * archivo aparte y no ahí.
 */
export type OrgRole = 'owner' | 'director' | 'manager' | 'operator';

export const ORG_ROLES: readonly OrgRole[] = ['owner', 'director', 'manager', 'operator'];

/**
 * `tenant.role` puede traer varios roles separados por coma (Better Auth lo
 * permite). `hasCapability` (`access-control.ts`) autoriza ahí si CUALQUIERA
 * de los roles alcanza, porque esa es una capacidad gruesa ("puede crear
 * tareas sí/no") donde no importa cuál de los roles fue el que autorizó. Acá
 * sí importa: `resolveTaskStatusTransition` usa el rol para dos cosas
 * distintas (qué transiciones permite, y si el chequeo de `isAssignee`
 * aplica), así que "alcanza con que uno autorice" no tiene una respuesta
 * única cuando los roles no serían equivalentes para ambos chequeos. En vez
 * de elegir en silencio cuál usar (y que el resultado dependa del orden en
 * que llegaron), esto falla fuerte: un miembro real con más de un rol
 * distinto es un caso que hay que decidir explícitamente, no adivinar.
 *
 * También falla fuerte si el rol no es ninguno de los cuatro conocidos. Un
 * valor como `"admin"` nunca debería llegar por un flujo propio — nada a
 * nivel de tipos lo impide en tiempo de ejecución, `tenant.role` es `string`
 * a secas — y sin este chequeo el resultado era "tu rol no tiene permiso"
 * desde `resolveTaskStatusTransition`, un mensaje engañoso para lo que en
 * realidad es un dato corrupto, no una autorización que falta.
 */
export function parseSingleOrgRole(roleString: string): OrgRole {
  const roles = [...new Set(roleString.split(',').map((role) => role.trim()))];
  const [role] = roles;
  if (roles.length !== 1 || !ORG_ROLES.includes(role as OrgRole)) {
    throw new Error(
      `Se esperaba un solo rol conocido (${ORG_ROLES.join('|')}) para evaluar la máquina de ` +
        `estados, se recibió "${roleString}". hasCapability sí soporta varios roles separados ` +
        'por coma para capacidades gruesas; acá no hay una forma segura de "alcanza con que uno ' +
        'autorice" (ver el comentario de OrgRole), ni un rol que no sea ninguno de los cuatro ' +
        'conocidos.',
    );
  }
  return role as OrgRole;
}
