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
  task: ['create'],
} as const;

export const accessControl = createAccessControl(statement);

export const ownerRole = accessControl.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  task: ['create'],
});

export const directorRole = accessControl.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  task: ['create'],
});

/** Alcance por sitio (`member_site_access`) se resuelve aparte, en dominio. */
export const managerRole = accessControl.newRole({
  member: ['create', 'update'],
  invitation: ['create'],
  task: ['create'],
});

/**
 * Nivel 3: "sus tareas y su sitio" (CLAUDE.md §7) es actuar sobre lo que ya
 * le asignaron, no crear tareas nuevas — por eso no tiene `task:create`.
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
