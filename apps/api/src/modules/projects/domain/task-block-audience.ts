/**
 * A quién se avisa cuando se bloquea una tarea (docs/phase-2-brief.md, "Decisiones de
 * notificaciones", y ADR-019). Regla pura: recibe los grupos ya leídos y los combina, sin tocar la
 * base.
 *
 *  - los miembros explícitos del proyecto, el creador incluido;
 *  - si el proyecto es de sitio, los `manager` con acceso a ese sitio;
 *  - el responsable de la tarea;
 *  - menos quien reportó el bloqueo: ve su propia tarea y no se revela nada.
 *
 * `owner` y `director` NO entran por ser privilegiados: solo si además son miembros explícitos.
 * Avisarle a quien no ve un proyecto reservado revelaría que existe. El filtro de "sigue siendo
 * miembro de la organización" no está acá: lo da la base (`TenancyService`).
 */
export function resolveTaskBlockAudience(params: {
  explicitMemberIds: readonly string[];
  /** Solo se tiene en cuenta si el proyecto es de sitio. */
  siteManagerMemberIds: readonly string[];
  projectVisibility: string;
  assigneeMemberId: string | null;
  reporterMemberId: string;
}): string[] {
  const candidates = new Set<string>(params.explicitMemberIds);
  if (params.projectVisibility === 'site') {
    for (const memberId of params.siteManagerMemberIds) candidates.add(memberId);
  }
  if (params.assigneeMemberId) candidates.add(params.assigneeMemberId);
  candidates.delete(params.reporterMemberId);
  return [...candidates].sort();
}
