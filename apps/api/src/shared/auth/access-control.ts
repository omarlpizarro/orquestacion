import { createAccessControl } from 'better-auth/plugins/access';

/**
 * Los cuatro niveles de CLAUDE.md §7. `owner` y `director` comparten alcance
 * (toda la organización); se distinguen dos roles por semántica de negocio,
 * no por capacidad. El nivel 4 (invitado) no es un rol de Better Auth: nunca
 * es `member`, entra por `guest_link` con un token firmado.
 */
export const statement = {
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
} as const;

export const accessControl = createAccessControl(statement);

export const ownerRole = accessControl.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

export const directorRole = accessControl.newRole({
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
});

/** Alcance por sitio (`member_site_access`) se resuelve aparte, en dominio. */
export const managerRole = accessControl.newRole({
  member: ['create', 'update'],
  invitation: ['create'],
});

export const operatorRole = accessControl.newRole({
  member: [],
  invitation: [],
});

export const organizationRoles = {
  owner: ownerRole,
  director: directorRole,
  manager: managerRole,
  operator: operatorRole,
};
