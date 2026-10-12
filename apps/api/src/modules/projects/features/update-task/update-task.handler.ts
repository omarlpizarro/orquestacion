import { Injectable } from '@nestjs/common';
import type { TaskOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import { TenancyService } from '../../../tenancy/tenancy.module.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { TaskDatesIncoherentError } from '../../domain/errors/task-dates-incoherent.error.js';
import { TaskEditForbiddenError } from '../../domain/errors/task-edit-forbidden.error.js';
import { TaskEditProjectAccessError } from '../../domain/errors/task-edit-project-access.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import { localDatetimeToUtc } from '../../domain/local-datetime-to-utc.js';
import {
  diffTaskPatch,
  type EditableTaskFields,
  type TaskCriticality,
  type TaskPatch,
} from '../../domain/task-patch.js';
import {
  findProjectForTenant,
  findVisibleTask,
  type TaskRow,
  updateTaskFields,
} from '../../infrastructure/task.repository.js';
import { toTaskOutput } from '../../infrastructure/task-output.mapper.js';
import { ProjectAccessService } from '../../project-access.service.js';
import type { UpdateTaskCommand } from './update-task.command.js';

interface UpdateOutcome {
  task: TaskRow;
  /** Los campos que cambiaron; vacío si fue un reintento o un pedido sin cambios reales. */
  changedFields: string[];
}

function editableFieldsOf(task: TaskRow): EditableTaskFields {
  return {
    title: task.title,
    description: task.description,
    criticality: task.criticality as TaskCriticality,
    plannedStartAt: task.plannedStartAt,
    plannedEndAt: task.plannedEndAt,
  };
}

@Injectable()
export class UpdateTaskHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly tenancy: TenancyService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  async execute(command: UpdateTaskCommand): Promise<TaskOutput> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('update-task requiere una sesión con organización activa.');
    }

    const { task, changedFields } = await this.transactions.withTenant((tx) =>
      this.applyMutation(command, tenant, tx),
    );

    // Después del commit, nunca desde dentro del callback (ADR-009). Un reintento o un
    // pedido sin cambios reales no cambió nada: no hay evento.
    if (changedFields.length > 0) {
      domainEvents.emitEvent('task.updated', {
        taskId: task.id,
        organizationId: tenant.organizationId,
        projectId: task.projectId,
        changedFields,
        requestId,
      });
    }

    return toTaskOutput(task);
  }

  private async applyMutation(
    command: UpdateTaskCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<UpdateOutcome> {
    const { organizationId, memberId } = tenant;

    // Primera sentencia de la transacción: se reserva la mutación antes de leer la
    // tarea (ADR-007).
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'task.update',
      entityId: command.id,
    });
    if (!claim.claimed) {
      const existing = await findVisibleTask(tx, { organizationId, taskId: command.id });
      // Si ya no la ve (le sacaron el acceso, o la borraron), no hay respuesta que reconstruir.
      if (!existing) throw new TaskNotFoundError(command.id);
      return { task: existing, changedFields: [] };
    }

    // Orden fijo de ADR-017 §6: 404 → 403 → 409. RLS devuelve "no existe" para una
    // tarea que quien pide no ve.
    const current = await findVisibleTask(tx, { organizationId, taskId: command.id });
    if (!current) throw new TaskNotFoundError(command.id);

    // Edita el rol con `task:update` (owner, director, manager) y solo con acceso
    // completo al proyecto: ver la tarea porque la tiene asignada no alcanza. El
    // operario no edita, tampoco la suya. La respuesta sobre el acceso la da la base.
    if (!hasCapability(tenant.role, { task: ['update'] })) throw new TaskEditForbiddenError();
    if (!(await this.projectAccess.hasFullAccess(tx, { projectId: current.projectId }))) {
      throw new TaskEditProjectAccessError();
    }

    // Después de autorizar, a propósito: un 409 le diría a quien no puede tocar la
    // tarea que existe y que cambió desde que la vio. En las fechas gana el servidor
    // (CLAUDE.md §9): una versión vieja se rechaza, nunca se mezcla.
    if (current.version !== command.expected_version) {
      throw new TaskVersionMismatchError(command.id, command.expected_version);
    }

    const patch = await this.toPatch(tx, command, current);
    const { changes, changedFields, datesIncoherent } = diffTaskPatch(
      editableFieldsOf(current),
      patch,
    );
    if (datesIncoherent) throw new TaskDatesIncoherentError();

    // Un pedido sin cambios reales no escribe: no sube la versión ni deja una entrada
    // vacía en el audit. La reserva de la mutación sí queda (es una operación aplicada).
    if (changedFields.length === 0) return { task: current, changedFields: [] };

    const updated = await updateTaskFields(tx, {
      organizationId,
      taskId: command.id,
      expectedVersion: command.expected_version,
      changes,
    });
    // `current` confirmó que la tarea existe: si acá vuelve vacío es porque alguien más
    // ganó la carrera entre esa lectura y este `UPDATE ... WHERE version = $esperado`.
    if (!updated) throw new TaskVersionMismatchError(command.id, command.expected_version);

    return { task: updated, changedFields };
  }

  /**
   * El pedido en la forma del dominio. Las fechas llegan como hora de pared del sitio
   * del proyecto y se convierten a UTC con la zona de ese sitio, igual que en
   * `create-task` (ADR-008); la zona solo se resuelve si el pedido trae una fecha.
   */
  private async toPatch(tx: Tx, command: UpdateTaskCommand, current: TaskRow): Promise<TaskPatch> {
    const { planned_start_at: start, planned_end_at: end } = command;
    let timeZone: string | null = null;
    if (start != null || end != null) {
      const project = await findProjectForTenant(tx, {
        organizationId: current.organizationId,
        projectId: current.projectId,
      });
      if (!project) throw new ProjectNotFoundError(current.projectId);
      timeZone = await this.tenancy.resolveTimezone(tx, {
        organizationId: current.organizationId,
        siteId: project.siteId,
      });
    }
    const toUtc = (local: string | null | undefined): string | null | undefined =>
      local == null || timeZone === null ? local : localDatetimeToUtc(local, timeZone);

    return {
      title: command.title,
      description: command.description,
      criticality: command.criticality,
      plannedStartAt: toUtc(start),
      plannedEndAt: toUtc(end),
    };
  }
}
