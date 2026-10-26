import type { ProjectOutput } from '@orq/contracts';

/** El estado de un proyecto no es un estado de tarea: no lleva chip ni color, solo texto. */
export const projectStatusLabels: Record<ProjectOutput['status'], string> = {
  planning: 'En planificación',
  active: 'Activo',
  on_hold: 'En pausa',
  archived: 'Archivado',
};
