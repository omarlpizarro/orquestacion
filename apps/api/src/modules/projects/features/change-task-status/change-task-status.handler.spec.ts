import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import type { CollaborationService } from '../../../collaboration/collaboration.module.js';
import type { NotificationsService } from '../../../notifications/notifications.module.js';
import { InvalidTaskStatusTransitionError } from '../../domain/errors/invalid-task-status-transition.error.js';
import { ReasonRequiredError } from '../../domain/errors/reason-required.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskStatusTransitionForbiddenError } from '../../domain/errors/task-status-transition-forbidden.error.js';
import { TaskStatusTransitionRequiresAssigneeError } from '../../domain/errors/task-status-transition-requires-assignee.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import {
  findTaskById,
  type TaskRow,
  updateTaskStatus,
} from '../../infrastructure/task.repository.js';
import type { ProjectAccessService } from '../../project-access.service.js';
import type { ProjectAudienceService } from '../../project-audience.service.js';
import type { ChangeTaskStatusCommand } from './change-task-status.command.js';
import { ChangeTaskStatusHandler } from './change-task-status.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({
  claimMutation: vi.fn(),
}));
vi.mock('../../infrastructure/task.repository.js', () => ({
  findTaskById: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'operator' };

const baseCommand: ChangeTaskStatusCommand = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  to_status: 'in_progress',
  expected_version: 1,
};

const pendingTask: TaskRow = {
  id: baseCommand.id,
  organizationId: tenant.organizationId,
  projectId: '01945f4e-0000-7000-8000-000000000002',
  parentTaskId: null,
  depth: 1,
  title: 'Excavar cimientos',
  description: null,
  status: 'pending',
  criticality: 'normal',
  assigneeMemberId: tenant.memberId,
  plannedStartAt: null,
  plannedEndAt: null,
  isMilestone: false,
  ackRequired: false,
  position: 'a0',
  version: 1,
  createdAt: '2026-09-20T00:00:00.000Z',
};

const inProgressTask: TaskRow = { ...pendingTask, status: 'in_progress', version: 2 };

function buildHandler(options: { hasFullProjectAccess?: boolean } = {}) {
  const hasFullAccess = vi.fn().mockResolvedValue(options.hasFullProjectAccess ?? true);
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const transactions = { withTenant } as unknown as TransactionService;
  const collaboration = {
    createTaskUpdate: vi.fn().mockResolvedValue({
      id: 'update-1',
      taskId: baseCommand.id,
      kind: 'status_change',
      body: null,
      createdAt: '2026-09-20T00:00:00.000Z',
    }),
  } as unknown as CollaborationService;
  const notifications = {
    notifyTaskAssigned: vi.fn().mockResolvedValue(undefined),
    notifyTaskBlocked: vi.fn().mockResolvedValue(undefined),
    enqueueTaskBlockedFanout: vi.fn().mockResolvedValue(undefined),
  };
  const audience = {
    listTaskBlockAudience: vi.fn().mockResolvedValue({
      taskUpdateId: 'update-1',
      taskId: baseCommand.id,
      projectId: '01945f4e-0000-7000-8000-000000000002',
      taskTitle: 'Excavar cimientos',
      reporterMemberId: 'member_abc123',
      reason: 'Falta el permiso',
      recipientMemberIds: ['member_operario', 'member_dueno'],
    }),
  };
  const projectAccess = { hasFullAccess } as unknown as ProjectAccessService;
  return {
    handler: new ChangeTaskStatusHandler(
      transactions,
      collaboration,
      projectAccess,
      notifications as unknown as NotificationsService,
      audience as unknown as ProjectAudienceService,
    ),
    collaboration,
    hasFullAccess,
    notifications,
    audience,
  };
}

function run<T>(command: ChangeTaskStatusCommand, handler: ChangeTaskStatusHandler): Promise<T> {
  return runWithRequestContext({ requestId: 'req-1', tenant }, () =>
    handler.execute(command),
  ) as Promise<T>;
}

describe('ChangeTaskStatusHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimMutation).mockResolvedValue({ claimed: true });
    vi.mocked(findTaskById).mockResolvedValue(pendingTask);
    vi.mocked(updateTaskStatus).mockResolvedValue(inProgressTask);
  });

  it('cambia el estado y devuelve la tarea actualizada', async () => {
    const { handler } = buildHandler();

    const result = await run(baseCommand, handler);

    expect(result).toMatchObject({ id: baseCommand.id, status: 'in_progress', version: 2 });
    expect(updateTaskStatus).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        taskId: baseCommand.id,
        expectedVersion: 1,
        toStatus: 'in_progress',
        setsActualEndAt: false,
        clearsActualEndAt: false,
      }),
    );
  });

  it('crea un task_update de tipo status_change con from/to en metadata cuando la transición no exige motivo', async () => {
    const { handler, collaboration } = buildHandler();

    await run(baseCommand, handler);

    expect(collaboration.createTaskUpdate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        taskId: baseCommand.id,
        kind: 'status_change',
        body: null,
        metadata: { from: 'pending', to: 'in_progress' },
      }),
    );
  });

  it('crea un task_update de tipo block_report con el motivo en body al bloquear', async () => {
    vi.mocked(findTaskById).mockResolvedValue({ ...pendingTask, status: 'in_progress' });
    vi.mocked(updateTaskStatus).mockResolvedValue({
      ...pendingTask,
      status: 'blocked',
      version: 2,
    });
    const { handler, collaboration } = buildHandler();

    await run(
      { ...baseCommand, to_status: 'blocked', reason: 'Falta el permiso municipal' },
      handler,
    );

    expect(collaboration.createTaskUpdate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        kind: 'block_report',
        body: 'Falta el permiso municipal',
        metadata: { from: 'in_progress', to: 'blocked' },
      }),
    );
  });

  it('guarda el motivo recortado de espacios, no el que mandó el cliente tal cual', async () => {
    vi.mocked(findTaskById).mockResolvedValue({ ...pendingTask, status: 'in_progress' });
    vi.mocked(updateTaskStatus).mockResolvedValue({
      ...pendingTask,
      status: 'blocked',
      version: 2,
    });
    const { handler, collaboration } = buildHandler();

    await run(
      { ...baseCommand, to_status: 'blocked', reason: '  Falta el permiso municipal  ' },
      handler,
    );

    expect(collaboration.createTaskUpdate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ body: 'Falta el permiso municipal' }),
    );
  });

  it('setsActualEndAt en true al completar la tarea', async () => {
    vi.mocked(findTaskById).mockResolvedValue({ ...pendingTask, status: 'in_progress' });
    vi.mocked(updateTaskStatus).mockResolvedValue({ ...pendingTask, status: 'done', version: 2 });
    const { handler } = buildHandler();

    await run({ ...baseCommand, to_status: 'done' }, handler);

    expect(updateTaskStatus).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ setsActualEndAt: true, clearsActualEndAt: false }),
    );
  });

  it('clearsActualEndAt en true y kind reopen al reabrir una tarea done (ADR-012), rol manager', async () => {
    vi.mocked(findTaskById).mockResolvedValue({
      ...pendingTask,
      status: 'done',
      assigneeMemberId: null,
    });
    vi.mocked(updateTaskStatus).mockResolvedValue({
      ...pendingTask,
      status: 'in_progress',
      version: 2,
    });
    const { handler, collaboration } = buildHandler();
    const manager = { ...tenant, role: 'manager' };

    await runWithRequestContext({ requestId: 'req-1', tenant: manager }, () =>
      handler.execute({
        ...baseCommand,
        to_status: 'in_progress',
        reason: 'Se cerró por error',
      }),
    );

    expect(updateTaskStatus).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ clearsActualEndAt: true, setsActualEndAt: false }),
    );
    expect(collaboration.createTaskUpdate).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ kind: 'reopen', body: 'Se cerró por error' }),
    );
  });

  it('rechaza con TaskNotFoundError si la tarea no existe', async () => {
    vi.mocked(findTaskById).mockResolvedValue(null);
    const { handler } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('rechaza con TaskVersionMismatchError si expected_version no coincide con la fila leída', async () => {
    vi.mocked(findTaskById).mockResolvedValue({ ...pendingTask, version: 5 });
    const { handler } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(TaskVersionMismatchError);
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('rechaza con TaskVersionMismatchError si el UPDATE afecta cero filas (carrera entre la lectura y el update)', async () => {
    vi.mocked(updateTaskStatus).mockResolvedValue(null);
    const { handler } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(TaskVersionMismatchError);
  });

  it('propaga InvalidTaskStatusTransitionError para una transición que no existe', async () => {
    const { handler } = buildHandler();

    await expect(run({ ...baseCommand, to_status: 'done' }, handler)).rejects.toBeInstanceOf(
      InvalidTaskStatusTransitionError,
    );
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('propaga TaskStatusTransitionForbiddenError si el rol no puede hacer esa transición', async () => {
    vi.mocked(findTaskById).mockResolvedValue({ ...pendingTask, status: 'in_review' });
    const { handler } = buildHandler();

    await expect(run({ ...baseCommand, to_status: 'done' }, handler)).rejects.toBeInstanceOf(
      TaskStatusTransitionForbiddenError,
    );
  });

  it('propaga TaskStatusTransitionRequiresAssigneeError si un operator no asignado intenta transicionar', async () => {
    vi.mocked(findTaskById).mockResolvedValue({
      ...pendingTask,
      assigneeMemberId: 'otro-member',
    });
    const { handler } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(
      TaskStatusTransitionRequiresAssigneeError,
    );
  });

  it('le pregunta a la base si tiene acceso completo al proyecto de la tarea', async () => {
    const { handler, hasFullAccess } = buildHandler();

    await run(baseCommand, handler);

    expect(hasFullAccess).toHaveBeenCalledWith({}, { projectId: pendingTask.projectId });
  });

  it('una tarea que quien pide no ve (RLS) es 404 y no toca nada: no se entera de si existe', async () => {
    vi.mocked(findTaskById).mockResolvedValue(null);
    const { handler, collaboration, hasFullAccess } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(hasFullAccess).not.toHaveBeenCalled();
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(collaboration.createTaskUpdate).not.toHaveBeenCalled();
  });

  it('un manager solo asignado (sin acceso completo) cambia el estado de SU tarea: el dominio no lo corta por sitio', async () => {
    vi.mocked(findTaskById).mockResolvedValue({
      ...pendingTask,
      assigneeMemberId: tenant.memberId,
    });
    const { handler } = buildHandler({ hasFullProjectAccess: false });
    const manager = { ...tenant, role: 'manager' };

    const result = await runWithRequestContext({ requestId: 'req-1', tenant: manager }, () =>
      handler.execute(baseCommand),
    );

    expect(result.status).toBe('in_progress');
  });

  it('un operator que no es el asignado con una versión vieja recibe 403, no 409', async () => {
    vi.mocked(findTaskById).mockResolvedValue({
      ...pendingTask,
      assigneeMemberId: 'otro-member',
      version: 5,
    });
    const { handler } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(
      TaskStatusTransitionRequiresAssigneeError,
    );
  });

  it('quien sí está autorizado recibe 409 con una versión vieja, y no se escribe nada', async () => {
    vi.mocked(findTaskById).mockResolvedValue({ ...pendingTask, version: 5 });
    const { handler, collaboration } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(TaskVersionMismatchError);
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(collaboration.createTaskUpdate).not.toHaveBeenCalled();
  });

  it('un operator con acceso a una tarea sin asignar puede bloquearla, pero no arrancarla', async () => {
    vi.mocked(findTaskById).mockResolvedValue({ ...pendingTask, assigneeMemberId: null });
    vi.mocked(updateTaskStatus).mockResolvedValue({
      ...pendingTask,
      assigneeMemberId: null,
      status: 'blocked',
      version: 2,
    });
    const { handler } = buildHandler();

    const blocked = await run<{ status: string }>(
      { ...baseCommand, to_status: 'blocked', reason: 'Falta el permiso municipal' },
      handler,
    );
    expect(blocked.status).toBe('blocked');

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(
      TaskStatusTransitionRequiresAssigneeError,
    );
  });

  it('un operator sin acceso completo al proyecto no puede bloquear una tarea sin asignar', async () => {
    vi.mocked(findTaskById).mockResolvedValue({ ...pendingTask, assigneeMemberId: null });
    const { handler } = buildHandler({ hasFullProjectAccess: false });

    await expect(
      run({ ...baseCommand, to_status: 'blocked', reason: 'Falta el permiso' }, handler),
    ).rejects.toBeInstanceOf(TaskStatusTransitionRequiresAssigneeError);
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('propaga ReasonRequiredError al bloquear sin motivo', async () => {
    const { handler } = buildHandler();

    await expect(run({ ...baseCommand, to_status: 'blocked' }, handler)).rejects.toBeInstanceOf(
      ReasonRequiredError,
    );
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('un member con más de un rol distinto hace fallar fuerte, no elige uno en silencio', async () => {
    const { handler } = buildHandler();
    const multiRole = { ...tenant, role: 'manager,operator' };

    await expect(
      runWithRequestContext({ requestId: 'req-1', tenant: multiRole }, () =>
        handler.execute(baseCommand),
      ),
    ).rejects.toThrow();
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('el mismo rol repetido no cuenta como "varios": no falla', async () => {
    const { handler } = buildHandler();
    const repeatedRole = { ...tenant, role: 'operator,operator' };

    const result = await runWithRequestContext({ requestId: 'req-1', tenant: repeatedRole }, () =>
      handler.execute(baseCommand),
    );

    expect(result.status).toBe('in_progress');
  });

  it('emite task.status_changed después de aplicar el cambio, no antes', async () => {
    const { handler } = buildHandler();
    const spy = vi.fn();
    domainEvents.onEvent('task.status_changed', spy);

    await run(baseCommand, handler);

    expect(spy).toHaveBeenCalledWith({
      taskId: baseCommand.id,
      organizationId: tenant.organizationId,
      fromStatus: 'pending',
      toStatus: 'in_progress',
      requestId: 'req-1',
    });
    domainEvents.removeListener('task.status_changed', spy);
  });

  it('reserva la mutación como primera sentencia, antes de leer la tarea (ADR-007)', async () => {
    const { handler } = buildHandler();

    await run(baseCommand, handler);

    expect(claimMutation).toHaveBeenCalledWith(
      {},
      {
        clientMutationId: baseCommand.client_mutation_id,
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        kind: 'task.change-status',
        entityId: baseCommand.id,
      },
    );
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(claimMutation)).toBeLessThan(order(findTaskById));
  });

  it('reintento con el mismo client_mutation_id no vuelve a aplicar la mutación ni a emitir el evento', async () => {
    vi.mocked(claimMutation).mockResolvedValue({
      claimed: false,
      prior: {
        kind: 'task.change-status',
        entityId: baseCommand.id,
        result: 'applied',
        rejectionReason: null,
      },
    });
    vi.mocked(findTaskById).mockResolvedValue(inProgressTask);
    const { handler, collaboration } = buildHandler();
    const spy = vi.fn();
    domainEvents.onEvent('task.status_changed', spy);

    const result = await run<{ id: string; status: string }>(baseCommand, handler);

    expect(result.status).toBe('in_progress');
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(collaboration.createTaskUpdate).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    domainEvents.removeListener('task.status_changed', spy);
  });

  it('el pedido duplicado no responde un error de dominio por el estado que dejó el primero', async () => {
    // Antes de reservar primero, el duplicado leía la tarea ya en `in_progress` y
    // respondía 422 (transición inválida) o 409 (versión). Ahora no lo evalúa.
    vi.mocked(claimMutation).mockResolvedValue({
      claimed: false,
      prior: {
        kind: 'task.change-status',
        entityId: baseCommand.id,
        result: 'applied',
        rejectionReason: null,
      },
    });
    vi.mocked(findTaskById).mockResolvedValue({ ...inProgressTask, version: 5 });
    const { handler } = buildHandler();

    const result = await run<{ status: string; version: number }>(baseCommand, handler);

    expect(result).toMatchObject({ status: 'in_progress', version: 5 });
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('lanza si no hay organización activa en el contexto', async () => {
    const { handler } = buildHandler();

    await expect(
      runWithRequestContext({ requestId: 'req-1' }, () => handler.execute(baseCommand)),
    ).rejects.toThrow(/sesión con organización activa/);
  });
  describe('avisos de un bloqueo (ADR-019)', () => {
    const blockedBy = (role: string, memberId: string) => ({ ...tenant, role, memberId });
    const blockCommand = {
      ...baseCommand,
      to_status: 'blocked' as const,
      reason: 'Falta el permiso',
    };
    const inProgress = (assignee: string | null): TaskRow => ({
      ...pendingTask,
      status: 'in_progress',
      assigneeMemberId: assignee,
    });
    const blocked = (assignee: string | null): TaskRow => ({
      ...pendingTask,
      status: 'blocked',
      assigneeMemberId: assignee,
      version: 2,
    });

    it('calcula la audiencia con la misma función que usa el worker, con la identidad de quien bloquea', async () => {
      vi.mocked(findTaskById).mockResolvedValue(inProgress(tenant.memberId));
      vi.mocked(updateTaskStatus).mockResolvedValue(blocked(tenant.memberId));
      const { handler, audience } = buildHandler();

      await run(blockCommand, handler);

      expect(audience.listTaskBlockAudience).toHaveBeenCalledWith(
        {},
        { organizationId: tenant.organizationId, taskUpdateId: 'update-1' },
      );
    });

    it('avisa a toda la audiencia que alcanza a ver, en la misma transacción', async () => {
      vi.mocked(findTaskById).mockResolvedValue(inProgress('member_operario'));
      vi.mocked(updateTaskStatus).mockResolvedValue(blocked('member_operario'));
      const { handler, notifications } = buildHandler();

      await runWithRequestContext(
        { requestId: 'req-1', tenant: blockedBy('manager', 'member_gerente') },
        () => handler.execute(blockCommand),
      );

      expect(notifications.notifyTaskBlocked).toHaveBeenCalledWith(
        {},
        {
          organizationId: tenant.organizationId,
          actorMemberId: 'member_gerente',
          recipientMemberIds: ['member_operario', 'member_dueno'],
          taskId: baseCommand.id,
          projectId: pendingTask.projectId,
          taskTitle: 'Excavar cimientos',
          taskUpdateId: 'update-1',
          reason: 'Falta el permiso',
        },
      );
    });

    it('y deja siempre el pedido en la bandeja, con el id de la novedad, para que el worker complete', async () => {
      vi.mocked(findTaskById).mockResolvedValue(inProgress(tenant.memberId));
      vi.mocked(updateTaskStatus).mockResolvedValue(blocked(tenant.memberId));
      const { handler, notifications } = buildHandler();

      await run(blockCommand, handler);

      expect(notifications.enqueueTaskBlockedFanout).toHaveBeenCalledWith(
        {},
        {
          organizationId: tenant.organizationId,
          actorMemberId: tenant.memberId,
          taskUpdateId: 'update-1',
        },
      );
    });

    it('si quien bloquea no ve a nadie (audiencia vacía) igual encola, y no avisa a nadie directo', async () => {
      vi.mocked(findTaskById).mockResolvedValue(inProgress(tenant.memberId));
      vi.mocked(updateTaskStatus).mockResolvedValue(blocked(tenant.memberId));
      const { handler, notifications, audience } = buildHandler();
      audience.listTaskBlockAudience.mockResolvedValue(null);

      await run(blockCommand, handler);

      expect(notifications.notifyTaskBlocked).not.toHaveBeenCalled();
      expect(notifications.enqueueTaskBlockedFanout).toHaveBeenCalledTimes(1);
    });

    it('una transición que no es un bloqueo no calcula audiencia ni avisa ni encola', async () => {
      const { handler, notifications, audience } = buildHandler();

      await run(baseCommand, handler);

      expect(audience.listTaskBlockAudience).not.toHaveBeenCalled();
      expect(notifications.notifyTaskBlocked).not.toHaveBeenCalled();
      expect(notifications.enqueueTaskBlockedFanout).not.toHaveBeenCalled();
    });

    it('un reintento (la mutación ya estaba reservada) no calcula, ni avisa, ni encola de nuevo', async () => {
      vi.mocked(claimMutation).mockResolvedValue({
        claimed: false,
        prior: {
          kind: 'task.change-status',
          entityId: baseCommand.id,
          result: 'applied',
          rejectionReason: null,
        },
      });
      vi.mocked(findTaskById).mockResolvedValue(blocked(tenant.memberId));
      const { handler, notifications, audience } = buildHandler();

      await run(blockCommand, handler);

      expect(audience.listTaskBlockAudience).not.toHaveBeenCalled();
      expect(notifications.enqueueTaskBlockedFanout).not.toHaveBeenCalled();
      expect(notifications.notifyTaskBlocked).not.toHaveBeenCalled();
    });

    it('si encolar falla, el error se propaga (la transacción hace rollback con el bloqueo)', async () => {
      vi.mocked(findTaskById).mockResolvedValue(inProgress(tenant.memberId));
      vi.mocked(updateTaskStatus).mockResolvedValue(blocked(tenant.memberId));
      const { handler, notifications } = buildHandler();
      notifications.enqueueTaskBlockedFanout.mockRejectedValue(new Error('boom'));

      await expect(run(blockCommand, handler)).rejects.toThrow('boom');
    });
  });
});
