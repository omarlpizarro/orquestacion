/**
 * Reglas de ADR-017 §8, puras: quién cambia la visibilidad de un proyecto y
 * quién maneja sus miembros. La capacidad por rol (`project:change_visibility`,
 * `project:manage_members`) y el acceso completo vienen de afuera; "es el
 * creador" es un dato del proyecto (`created_by_member_id`) que arma el handler.
 */
export interface ProjectManagementContext {
  /** Acceso completo al proyecto, calculado por la base. Ver el proyecto solo por una tarea asignada no alcanza. */
  hasFullAccess: boolean;
  /** `owner`/`director`: la capacidad de rol. */
  hasRoleCapability: boolean;
  isCreator: boolean;
}

/**
 * Cambiar la visibilidad y agregar miembros: el creador, `owner` y `director`,
 * siempre con acceso completo. Un creador al que quitaron pierde el derecho
 * junto con el acceso.
 */
export function canManageProject(context: ProjectManagementContext): boolean {
  return context.hasFullAccess && (context.hasRoleCapability || context.isCreator);
}

export interface MemberRemovalContext extends ProjectManagementContext {
  targetMemberId: string;
  actorMemberId: string;
  creatorMemberId: string;
}

export type MemberRemovalDecision = 'allowed' | 'forbidden' | 'creator_removal_forbidden';

/**
 * Quitar un miembro:
 * - Al creador lo quitan solo `owner` o `director` (capacidad de rol), y no
 *   puede salirse por su cuenta si no la tiene.
 * - Cualquier otro miembro puede salirse a sí mismo.
 * - Quitar a otro exige poder manejar el proyecto.
 */
export function decideMemberRemoval(context: MemberRemovalContext): MemberRemovalDecision {
  const targetIsCreator = context.targetMemberId === context.creatorMemberId;
  if (targetIsCreator) {
    return context.hasFullAccess && context.hasRoleCapability
      ? 'allowed'
      : 'creator_removal_forbidden';
  }
  if (context.targetMemberId === context.actorMemberId) return 'allowed';
  return canManageProject(context) ? 'allowed' : 'forbidden';
}
