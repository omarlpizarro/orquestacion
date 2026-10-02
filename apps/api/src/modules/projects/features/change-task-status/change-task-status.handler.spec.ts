import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findPriorMutation, recordMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import type { CollaborationService } from '../../../collaboration/collaboration.module.js';
import type { TenancyService } from '../../../tenancy/tenancy.module.js';
import { InvalidTaskStatusTransitionError } from '../../domain/errors/invalid-task-status-transition.error.js';
import { ReasonRequiredError } from '../../domain/errors/reason-required.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskSiteAccessForbiddenError } from '../../domain/errors/task-site-access-forbidden.error.js';
import { TaskStatusTransitionForbiddenError } from '../../domain/errors/task-status-transition-forbidden.error.js';
import { TaskStatusTransitionRequiresAssigneeError } from '../../domain/errors/task-status-transition-requires-assignee.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import {
  findTaskById,
  findTaskWithSiteById,
  type TaskWithSiteRow,
  updateTaskStatus,
} from '../../infrastructure/task.repository.js';
import type { ChangeTaskStatusCommand } from './change-task-status.command.js';
import { ChangeTaskStatusHandler } from './change-task-status.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({
  findPriorMutation: vi.fn(),
  recordMutation: vi.fn(),
}));
vi.mock('../../infrastructure/task.repository.js', () => ({
  findTaskById: vi.fn(),
  findTaskWithSiteById: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'operator' };

const baseCommand: ChangeTaskStatusCommand = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  to_status: 'in_progress',
  expected_version: 1,
};

const siteId = '01945f4e-0000-7000-8000-0000000000aa';

const pendingTask: TaskWithSiteRow = {
  siteId,
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

const inProgressTask: TaskWithSiteRow = { ...pendingTask, status: 'in_progress', version: 2 };

function buildHandler(options: { hasSiteAccess?: boolean } = {}) {
  const canAccessSite = vi.fn().mockResolvedValue(options.hasSiteAccess ?? true);
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
  const tenancy = { canAccessSite } as unknown as TenancyService;
  return {
    handler: new ChangeTaskStatusHandler(transactions, collaboration, tenancy),
    collaboration,
    canAccessSite,
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
    vi.mocked(findPriorMutation).mockResolvedValue(null);
    vi.mocked(findTaskWithSiteById).mockResolvedValue(pendingTask);
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
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, status: 'in_progress' });
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
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, status: 'in_progress' });
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
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, status: 'in_progress' });
    vi.mocked(updateTaskStatus).mockResolvedValue({ ...pendingTask, status: 'done', version: 2 });
    const { handler } = buildHandler();

    await run({ ...baseCommand, to_status: 'done' }, handler);

    expect(updateTaskStatus).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ setsActualEndAt: true, clearsActualEndAt: false }),
    );
  });

  it('clearsActualEndAt en true y kind reopen al reabrir una tarea done (ADR-012), rol manager', async () => {
    vi.mocked(findTaskWithSiteById).mockResolvedValue({
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
    vi.mocked(findTaskWithSiteById).mockResolvedValue(null);
    const { handler } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(updateTaskStatus).not.toHaveBeenCalled();
  });

  it('rechaza con TaskVersionMismatchError si expected_version no coincide con la fila leída', async () => {
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, version: 5 });
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
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, status: 'in_review' });
    const { handler } = buildHandler();

    await expect(run({ ...baseCommand, to_status: 'done' }, handler)).rejects.toBeInstanceOf(
      TaskStatusTransitionForbiddenError,
    );
  });

  it('propaga TaskStatusTransitionRequiresAssigneeError si un operator no asignado intenta transicionar', async () => {
    vi.mocked(findTaskWithSiteById).mockResolvedValue({
      ...pendingTask,
      assigneeMemberId: 'otro-member',
    });
    const { handler } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(
      TaskStatusTransitionRequiresAssigneeError,
    );
  });

  it('le pasa a canAccessSite el rol de quien pide y el sitio del proyecto de la tarea', async () => {
    const { handler, canAccessSite } = buildHandler();

    await run(baseCommand, handler);

    expect(canAccessSite).toHaveBeenCalledWith(
      {},
      {
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        role: 'operator',
        siteId,
      },
    );
  });

  it('un manager sin acceso al sitio de la tarea rechaza con TaskSiteAccessForbiddenError antes de tocar nada', async () => {
    const { handler, collaboration } = buildHandler({ hasSiteAccess: false });
    const manager = { ...tenant, role: 'manager' };

    await expect(
      runWithRequestContext({ requestId: 'req-1', tenant: manager }, () =>
        handler.execute(baseCommand),
      ),
    ).rejects.toBeInstanceOf(TaskSiteAccessForbiddenError);
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(collaboration.createTaskUpdate).not.toHaveBeenCalled();
    expect(recordMutation).not.toHaveBeenCalled();
  });

  it('un manager sin acceso con una versión vieja recibe 403, no 409: no se entera de que la tarea cambió', async () => {
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, version: 5 });
    const { handler } = buildHandler({ hasSiteAccess: false });
    const manager = { ...tenant, role: 'manager' };

    await expect(
      runWithRequestContext({ requestId: 'req-1', tenant: manager }, () =>
        handler.execute(baseCommand),
      ),
    ).rejects.toBeInstanceOf(TaskSiteAccessForbiddenError);
  });

  it('un operator que no es el asignado con una versión vieja recibe 403, no 409', async () => {
    vi.mocked(findTaskWithSiteById).mockResolvedValue({
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
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, version: 5 });
    const { handler, collaboration } = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(TaskVersionMismatchError);
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(collaboration.createTaskUpdate).not.toHaveBeenCalled();
  });

  it('un operator con acceso a una tarea sin asignar puede bloquearla, pero no arrancarla', async () => {
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, assigneeMemberId: null });
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

  it('un operator sin acceso al sitio no puede bloquear una tarea sin asignar', async () => {
    vi.mocked(findTaskWithSiteById).mockResolvedValue({ ...pendingTask, assigneeMemberId: null });
    const { handler } = buildHandler({ hasSiteAccess: false });

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

  it('reintento con el mismo client_mutation_id no vuelve a aplicar la mutación ni a emitir el evento', async () => {
    vi.mocked(findPriorMutation).mockResolvedValue({
      entityId: baseCommand.id,
      result: 'applied',
      rejectionReason: null,
    });
    vi.mocked(findTaskById).mockResolvedValue(inProgressTask);
    const { handler, collaboration } = buildHandler();
    const spy = vi.fn();
    domainEvents.onEvent('task.status_changed', spy);

    const result = await run<{ id: string; status: string }>(baseCommand, handler);

    expect(result.status).toBe('in_progress');
    expect(updateTaskStatus).not.toHaveBeenCalled();
    expect(collaboration.createTaskUpdate).not.toHaveBeenCalled();
    expect(recordMutation).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    domainEvents.removeListener('task.status_changed', spy);
  });

  it('si el registro de la mutación choca con una violación de unicidad, relee la mutación anterior en vez de romper con un 500 opaco', async () => {
    const uniqueViolation = Object.assign(
      new Error('duplicate key value violates unique constraint "mutation_log_pkey"'),
      { code: '23505' },
    );
    vi.mocked(recordMutation).mockRejectedValueOnce(uniqueViolation);
    vi.mocked(findPriorMutation).mockResolvedValueOnce(null).mockResolvedValueOnce({
      entityId: baseCommand.id,
      result: 'applied',
      rejectionReason: null,
    });
    vi.mocked(findTaskWithSiteById).mockResolvedValueOnce(pendingTask);
    vi.mocked(findTaskById).mockResolvedValueOnce(inProgressTask);
    const { handler } = buildHandler();

    const result = await run<{ status: string }>(baseCommand, handler);

    expect(result.status).toBe('in_progress');
  });

  it('lanza si no hay organización activa en el contexto', async () => {
    const { handler } = buildHandler();

    await expect(
      runWithRequestContext({ requestId: 'req-1' }, () => handler.execute(baseCommand)),
    ).rejects.toThrow(/sesión con organización activa/);
  });
});
