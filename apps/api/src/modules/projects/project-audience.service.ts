import { Injectable } from '@nestjs/common';
import type { Tx } from '@orq/db';
import { CollaborationService } from '../collaboration/collaboration.module.js';
import { TenancyService } from '../tenancy/tenancy.module.js';
import { resolveTaskBlockAudience } from './domain/task-block-audience.js';
import {
  findProjectById,
  listActiveProjectMemberIds,
} from './infrastructure/project.repository.js';
import { findTaskById } from './infrastructure/task.repository.js';

/** A quién avisar de un bloqueo, y de qué. */
export interface TaskBlockAudience {
  taskUpdateId: string;
  taskId: string;
  projectId: string;
  taskTitle: string;
  /** Quien reportó el bloqueo (el autor de la novedad). */
  reporterMemberId: string;
  /** El motivo, tal como quedó en la novedad. */
  reason: string | null;
  /** Ordenados; sin quien reportó; solo miembros que siguen en la organización. */
  recipientMemberIds: string[];
}

/**
 * `projects` es el dueño de "quién ve un proyecto" y, con ello, de a quién se avisa de lo que pasa
 * en él (ADR-019). Hay UNA sola definición de la audiencia de un bloqueo, y la usan los dos
 * procesos que la necesitan:
 *  - la API, en la transacción del bloqueo, con la identidad de quien bloquea;
 *  - el worker, con el contexto de sistema, cuando quien bloqueó no podía ver a todos.
 *
 * Lee con la identidad de `tx`: el resultado de la API es siempre un subconjunto del del worker
 * (RLS solo oculta filas, nunca inventa), así que nunca avisa a quien no corresponde; lo que no
 * alcanza a ver lo completa el worker. No guarda nada.
 */
@Injectable()
export class ProjectAudienceService {
  constructor(
    private readonly collaboration: CollaborationService,
    private readonly tenancy: TenancyService,
  ) {}

  /**
   * La audiencia del bloqueo registrado en la novedad `taskUpdateId`. Lo recalcula todo desde la
   * base a partir de ese id. `null` si no hay a quién ni qué avisar: la novedad no existe o no es un
   * reporte de bloqueo, o su tarea o su proyecto están borrados (o `tx` no los ve).
   */
  async listTaskBlockAudience(
    tx: Tx,
    params: { organizationId: string; taskUpdateId: string },
  ): Promise<TaskBlockAudience | null> {
    const { organizationId, taskUpdateId } = params;

    const update = await this.collaboration.findTaskUpdate(tx, {
      organizationId,
      id: taskUpdateId,
    });
    if (update?.kind !== 'block_report') return null;

    const task = await findTaskById(tx, { organizationId, taskId: update.taskId });
    if (!task) return null;
    const project = await findProjectById(tx, { organizationId, projectId: task.projectId });
    if (!project) return null;

    const [explicitMemberIds, siteManagerMemberIds] = await Promise.all([
      listActiveProjectMemberIds(tx, { organizationId, projectId: project.id }),
      project.visibility === 'site'
        ? this.tenancy.listSiteManagerMemberIds(tx, { organizationId, siteId: project.siteId })
        : Promise.resolve([]),
    ]);

    const candidates = resolveTaskBlockAudience({
      explicitMemberIds,
      siteManagerMemberIds,
      projectVisibility: project.visibility,
      assigneeMemberId: task.assigneeMemberId,
      reporterMemberId: update.createdByMemberId,
    });
    const recipientMemberIds = await this.tenancy.filterOrganizationMemberIds(tx, {
      organizationId,
      memberIds: candidates,
    });

    return {
      taskUpdateId: update.id,
      taskId: task.id,
      projectId: project.id,
      taskTitle: task.title,
      reporterMemberId: update.createdByMemberId,
      reason: update.body,
      recipientMemberIds,
    };
  }
}
