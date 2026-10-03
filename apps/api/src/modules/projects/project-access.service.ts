import { Injectable } from '@nestjs/common';
import type { Tx } from '@orq/db';
import {
  hasFullProjectAccess,
  isExplicitProjectMember,
} from './infrastructure/project-access.repository.js';

/**
 * Acceso de quien abrió la transacción a un proyecto (ADR-017). No decide nada
 * por su cuenta: pregunta a las funciones de RLS de la base, que son la única
 * implementación del cálculo.
 */
@Injectable()
export class ProjectAccessService {
  /**
   * Acceso completo: `owner`/`director`, miembro explícito, o proyecto abierto
   * al sitio de quien pregunta. Distinto de ver el proyecto solo porque tiene
   * una tarea asignada ("solo asignado").
   */
  hasFullAccess(tx: Tx, params: { projectId: string }): Promise<boolean> {
    return hasFullProjectAccess(tx, params);
  }

  isExplicitMember(
    tx: Tx,
    params: { organizationId: string; projectId: string; memberId: string },
  ): Promise<boolean> {
    return isExplicitProjectMember(tx, params);
  }
}
