/**
 * Qué acciones muestra la web según el rol. Es solo para no ofrecer un botón que la API va a rechazar: la
 * regla real vive en la API (`apps/api/src/shared/auth/access-control.ts`) y la hace cumplir ella, con un 403
 * si esto se desfasara. Better Auth puede devolver varios roles separados por coma.
 */
const PROJECT_CREATOR_ROLES: readonly string[] = ['owner', 'director'];

export function canCreateProject(role: string | null): boolean {
  if (!role) return false;
  return role.split(',').some((single) => PROJECT_CREATOR_ROLES.includes(single.trim()));
}
