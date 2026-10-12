import { createAccessControl } from 'better-auth/plugins/access';

/**
 * Los cuatro niveles de CLAUDE.md §7. `owner` y `director` comparten alcance
 * (toda la organización); se distinguen dos roles por semántica de negocio,
 * no por capacidad. El nivel 4 (invitado) no es un rol de Better Auth: nunca
 * es `member`, entra por `guest_link` con un token firmado.
 *
 * `task` (y las capacidades de negocio que se vayan agregando, `booking`,
 * `project`, etc.) conviven acá con los recursos propios de Better Auth
 * (`organization`, `member`, `invitation`): es el mismo mapa de rol a
 * capacidades que pide CLAUDE.md §7, no dos sistemas separados. Se
 * verifican en código con `hasCapability`, nunca contra la base.
 */
export const statement = {
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  task: ['create', 'update', 'assign'],
  project: ['create', 'change_visibility', 'manage_members'],
  site: ['grant_access'],
} as const;

export const accessControl = createAccessControl(statement);

export const ownerRole = accessControl.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  task: ['create', 'update', 'assign'],
  project: ['create', 'change_visibility', 'manage_members'],
  site: ['grant_access'],
});

export const directorRole = accessControl.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  task: ['create', 'update', 'assign'],
  project: ['create', 'change_visibility', 'manage_members'],
  site: ['grant_access'],
});

/**
 * Alcance por sitio (`member_site_access`) se resuelve aparte, en dominio. Sin
 * `project:*` (RF-C1: la creación de proyectos es del nivel 1): un manager no
 * crea proyectos. Sí puede cambiar la visibilidad o manejar los miembros de uno
 * que creó, pero eso no es una capacidad de rol sino un dato del proyecto
 * (`created_by_member_id`) que evalúa el handler (ADR-017 §8).
 */
export const managerRole = accessControl.newRole({
  member: ['create', 'update'],
  invitation: ['create'],
  task: ['create', 'update', 'assign'],
});

/**
 * Nivel 3: "sus tareas y su sitio" (CLAUDE.md §7) es actuar sobre lo que ya
 * le asignaron, no crear tareas nuevas — por eso no tiene `task:create`. Tampoco
 * `task:update`: no edita el título, la descripción, la criticidad ni las fechas,
 * ni siquiera de sus propias tareas; cambia el estado y comenta. Tampoco
 * `task:assign`: no reasigna.
 */
export const operatorRole = accessControl.newRole({
  member: [],
  invitation: [],
  task: [],
});

export const organizationRoles = {
  owner: ownerRole,
  director: directorRole,
  manager: managerRole,
  operator: operatorRole,
};

/**
 * Chequea una capacidad de negocio (`{ task: ['create'] }`) contra el rol
 * de un miembro. Better Auth permite roles múltiples separados por coma
 * (`member.role`, ver `crud-members.mjs`); alcanza con que uno solo
 * autorice. Un rol que no existe en `organizationRoles` (dato corrupto,
 * nunca de un flujo propio) no autoriza nada — no explota.
 *
 * Esto vale para una capacidad gruesa ("puede crear tareas sí/no"), donde
 * no importa cuál de los roles fue el que autorizó. No es la respuesta
 * correcta en todos lados: `parseSingleOrgRole`
 * (`modules/projects/domain/task-status.ts`) usa el rol para más de un
 * chequeo a la vez (qué transiciones permite, si `isAssignee` aplica), así
 * que ahí "alcanza con que uno autorice" no tiene una única respuesta —
 * falla fuerte en vez de elegir en silencio cuál rol usar.
 */
export function hasCapability(
  memberRole: string,
  request: Partial<{ [K in keyof typeof statement]: Array<(typeof statement)[K][number]> }>,
): boolean {
  return memberRole
    .split(',')
    .map((role) => role.trim())
    .some((role) => {
      const roleDefinition = organizationRoles[role as keyof typeof organizationRoles] as
        | { authorize: (req: typeof request) => { success: boolean } }
        | undefined;
      return roleDefinition?.authorize(request).success ?? false;
    });
}
