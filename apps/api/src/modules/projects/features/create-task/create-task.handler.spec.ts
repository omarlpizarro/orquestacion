import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { MutationIdReusedError } from '../../../../shared/errors/mutation-id-reused.error.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import type { NotificationsService } from '../../../notifications/notifications.module.js';
import type { TenancyService } from '../../../tenancy/tenancy.module.js';
import { AssigneeNotAssignableError } from '../../domain/errors/assignee-not-assignable.error.js';
import { ParentTaskNotFoundError } from '../../domain/errors/parent-task-not-found.error.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { TaskCreateForbiddenError } from '../../domain/errors/task-create-forbidden.error.js';
import { TaskCreateProjectAccessError } from '../../domain/errors/task-create-project-access.error.js';
import { TaskDatesIncoherentError } from '../../domain/errors/task-dates-incoherent.error.js';
import { TaskDepthExceededError } from '../../domain/errors/task-depth-exceeded.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import {
  findLastSiblingPosition,
  findParentTaskForTenant,
  findProjectForTenant,
  findTaskById,
  insertTask,
  type TaskRow,
} from '../../infrastructure/task.repository.js';
import type { ProjectAccessService } from '../../project-access.service.js';
import type { CreateTaskCommand } from './create-task.command.js';
import { CreateTaskHandler } from './create-task.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({
  claimMutation: vi.fn(),
}));
vi.mock('../../infrastructure/task.repository.js', () => ({
  findProjectForTenant: vi.fn(),
  findParentTaskForTenant: vi.fn(),
  findLastSiblingPosition: vi.fn(),
  insertTask: vi.fn(),
  findTaskById: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'owner' };

const baseCommand: CreateTaskCommand = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  project_id: '01945f4e-0000-7000-8000-000000000002',
  title: 'Preparar el frente norte',
};

const insertedTask: TaskRow = {
  id: baseCommand.id,
  organizationId: tenant.organizationId,
  projectId: baseCommand.project_id,
  parentTaskId: null,
  depth: 1,
  title: baseCommand.title,
  description: null,
  status: 'pending',
  criticality: 'normal',
  assigneeMemberId: null,
  plannedStartAt: null,
  plannedEndAt: null,
  isMilestone: false,
  ackRequired: false,
  position: 'a0',
  version: 1,
  createdAt: '2026-09-20T00:00:00.000Z',
};

const siteId = '01945f4e-0000-7000-8000-0000000000aa';

function buildHandler(
  options: {
    hasFullAccess?: boolean;
    isMemberAssignable?: boolean;
    isExplicitMember?: boolean;
    isMemberInOrganization?: boolean;
  } = {},
) {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const transactions = { withTenant } as unknown as TransactionService;
  const tenancy = {
    resolveTimezone: vi.fn().mockResolvedValue('America/Argentina/Buenos_Aires'),
    isMemberAssignable: vi.fn().mockResolvedValue(options.isMemberAssignable ?? true),
    isMemberInOrganization: vi.fn().mockResolvedValue(options.isMemberInOrganization ?? true),
  };
  const projectAccess = {
    hasFullAccess: vi.fn().mockResolvedValue(options.hasFullAccess ?? true),
    isExplicitMember: vi.fn().mockResolvedValue(options.isExplicitMember ?? false),
  };
  const notifications = {
    notifyTaskAssigned: vi.fn().mockResolvedValue(undefined),
    notifyTaskBlockedToAssignee: vi.fn().mockResolvedValue(undefined),
    enqueueTaskBlockedFanout: vi.fn().mockResolvedValue(undefined),
  };
  const handler = new CreateTaskHandler(
    transactions,
    tenancy as unknown as TenancyService,
    projectAccess as unknown as ProjectAccessService,
    notifications as unknown as NotificationsService,
  );
  return Object.assign(handler, {
    tenancyMock: tenancy,
    projectAccessMock: projectAccess,
    notificationsMock: notifications,
  });
}

function run<T>(command: CreateTaskCommand, handler: CreateTaskHandler): Promise<T> {
  return runWithRequestContext({ requestId: 'req-1', tenant }, () =>
    handler.execute(command),
  ) as Promise<T>;
}

describe('CreateTaskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimMutation).mockResolvedValue({ claimed: true });
    vi.mocked(findProjectForTenant).mockResolvedValue({ id: baseCommand.project_id, siteId });
    vi.mocked(findLastSiblingPosition).mockResolvedValue(null);
    vi.mocked(insertTask).mockResolvedValue(insertedTask);
  });

  it('crea la tarea y devuelve su forma pública', async () => {
    const handler = buildHandler();

    const result = await run(baseCommand, handler);

    expect(result).toEqual({
      id: insertedTask.id,
      project_id: insertedTask.projectId,
      parent_task_id: null,
      depth: insertedTask.depth,
      title: insertedTask.title,
      description: null,
      status: 'pending',
      criticality: 'normal',
      assignee_member_id: null,
      planned_start_at: null,
      planned_end_at: null,
      is_milestone: false,
      ack_required: false,
      position: 'a0',
      version: 1,
      created_at: insertedTask.createdAt,
    });
  });

  it('reserva la mutación como primera sentencia, antes de leer nada (ADR-007)', async () => {
    const handler = buildHandler();

    await run(baseCommand, handler);

    expect(claimMutation).toHaveBeenCalledWith(
      {},
      {
        clientMutationId: baseCommand.client_mutation_id,
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        kind: 'task.create',
        entityId: baseCommand.id,
      },
    );
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(claimMutation)).toBeLessThan(order(findProjectForTenant));
  });

  it('emite task.created después de crear la tarea', async () => {
    const handler = buildHandler();
    const spy = vi.fn();
    domainEvents.onEvent('task.created', spy);

    await run(baseCommand, handler);

    expect(spy).toHaveBeenCalledWith({
      taskId: insertedTask.id,
      organizationId: tenant.organizationId,
      projectId: insertedTask.projectId,
      requestId: 'req-1',
    });
    domainEvents.removeListener('task.created', spy);
  });

  it('reintento con el mismo client_mutation_id no vuelve a insertar ni a emitir el evento', async () => {
    vi.mocked(claimMutation).mockResolvedValue({
      claimed: false,
      prior: {
        kind: 'task.create',
        entityId: insertedTask.id,
        result: 'applied',
        rejectionReason: null,
      },
    });
    vi.mocked(findTaskById).mockResolvedValue(insertedTask);
    const handler = buildHandler();
    const spy = vi.fn();
    domainEvents.onEvent('task.created', spy);

    const result = await run<{ id: string }>(baseCommand, handler);

    expect(result.id).toBe(insertedTask.id);
    expect(insertTask).not.toHaveBeenCalled();
    expect(findProjectForTenant).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    domainEvents.removeListener('task.created', spy);
  });

  it('si la mutación ya está registrada pero la tarea ya no se ve, responde TaskNotFoundError', async () => {
    vi.mocked(claimMutation).mockResolvedValue({
      claimed: false,
      prior: {
        kind: 'task.create',
        entityId: insertedTask.id,
        result: 'applied',
        rejectionReason: null,
      },
    });
    vi.mocked(findTaskById).mockResolvedValue(null);
    const handler = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it('rechaza con ProjectNotFoundError si el proyecto no existe', async () => {
    vi.mocked(findProjectForTenant).mockResolvedValue(null);
    const handler = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it('rechaza con ParentTaskNotFoundError si la tarea padre no existe', async () => {
    vi.mocked(findParentTaskForTenant).mockResolvedValue(null);
    const handler = buildHandler();

    await expect(
      run({ ...baseCommand, parent_task_id: '01945f4e-0000-7000-8000-000000000009' }, handler),
    ).rejects.toBeInstanceOf(ParentTaskNotFoundError);
  });

  it('rechaza con TaskDepthExceededError si la tarea padre ya está en el nivel máximo', async () => {
    vi.mocked(findParentTaskForTenant).mockResolvedValue({
      id: '01945f4e-0000-7000-8000-000000000009',
      depth: 3,
    });
    const handler = buildHandler();

    await expect(
      run({ ...baseCommand, parent_task_id: '01945f4e-0000-7000-8000-000000000009' }, handler),
    ).rejects.toBeInstanceOf(TaskDepthExceededError);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it('lanza si no hay organización activa en el contexto', async () => {
    const handler = buildHandler();

    await expect(
      runWithRequestContext({ requestId: 'req-1' }, () => handler.execute(baseCommand)),
    ).rejects.toThrow(/sesión con organización activa/);
  });

  it('rechaza con TaskCreateForbiddenError si el rol no tiene la capacidad task:create', async () => {
    const handler = buildHandler();
    const operator = { ...tenant, role: 'operator' };

    await expect(
      runWithRequestContext({ requestId: 'req-1', tenant: operator }, () =>
        handler.execute(baseCommand),
      ),
    ).rejects.toBeInstanceOf(TaskCreateForbiddenError);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it('permite crear la tarea a un manager (tiene task:create)', async () => {
    const handler = buildHandler();
    const manager = { ...tenant, role: 'manager' };

    const result = await runWithRequestContext({ requestId: 'req-1', tenant: manager }, () =>
      handler.execute(baseCommand),
    );

    expect(result.id).toBe(insertedTask.id);
  });

  it('con acceso completo al proyecto crea la tarea; la pregunta de acceso la responde la base', async () => {
    const handler = buildHandler();
    const manager = { ...tenant, role: 'manager' };

    await runWithRequestContext({ requestId: 'req-1', tenant: manager }, () =>
      handler.execute(baseCommand),
    );

    expect(handler.projectAccessMock.hasFullAccess).toHaveBeenCalledWith(
      {},
      { projectId: baseCommand.project_id },
    );
    expect(insertTask).toHaveBeenCalled();
  });

  it('quien ve el proyecto solo por una tarea asignada rechaza con TaskCreateProjectAccessError y no inserta ni registra la mutación', async () => {
    const handler = buildHandler({ hasFullAccess: false });
    const manager = { ...tenant, role: 'manager' };

    await expect(
      runWithRequestContext({ requestId: 'req-1', tenant: manager }, () =>
        handler.execute(baseCommand),
      ),
    ).rejects.toBeInstanceOf(TaskCreateProjectAccessError);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it('orden 404 → 403: un operator que no ve el proyecto recibe 404, no el 403 de su rol', async () => {
    vi.mocked(findProjectForTenant).mockResolvedValue(null);
    const handler = buildHandler();
    const operator = { ...tenant, role: 'operator' };

    await expect(
      runWithRequestContext({ requestId: 'req-1', tenant: operator }, () =>
        handler.execute(baseCommand),
      ),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    expect(handler.projectAccessMock.hasFullAccess).not.toHaveBeenCalled();
  });

  it('valida assignee_member_id con isMemberAssignable sobre el sitio del proyecto', async () => {
    const handler = buildHandler();

    await run({ ...baseCommand, assignee_member_id: 'member_assignee' }, handler);

    expect(handler.tenancyMock.isMemberAssignable).toHaveBeenCalledWith(
      {},
      { organizationId: tenant.organizationId, memberId: 'member_assignee', siteId },
    );
    expect(insertTask).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ assigneeMemberId: 'member_assignee' }),
    );
  });

  it('asigna a un miembro explícito del proyecto aunque no tenga acceso al sitio (ADR-017 §8)', async () => {
    const handler = buildHandler({ isMemberAssignable: false, isExplicitMember: true });

    await run({ ...baseCommand, assignee_member_id: 'member_explicito' }, handler);

    expect(handler.projectAccessMock.isExplicitMember).toHaveBeenCalledWith(
      {},
      {
        organizationId: tenant.organizationId,
        projectId: baseCommand.project_id,
        memberId: 'member_explicito',
      },
    );
    expect(insertTask).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ assigneeMemberId: 'member_explicito' }),
    );
  });

  it('no asigna a quien figura en project_member pero ya no es de la organización', async () => {
    const handler = buildHandler({
      isMemberAssignable: false,
      isExplicitMember: true,
      isMemberInOrganization: false,
    });

    await expect(
      run({ ...baseCommand, assignee_member_id: 'member_ido' }, handler),
    ).rejects.toBeInstanceOf(AssigneeNotAssignableError);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it('rechaza con AssigneeNotAssignableError si el asignado no es de la organización o no trabaja en el sitio', async () => {
    const handler = buildHandler({ isMemberAssignable: false });

    await expect(
      run({ ...baseCommand, assignee_member_id: 'member_ajeno' }, handler),
    ).rejects.toBeInstanceOf(AssigneeNotAssignableError);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it('un fin planificado anterior al inicio (en la zona del sitio) es 422 y no inserta', async () => {
    const handler = buildHandler();

    await expect(
      run(
        {
          ...baseCommand,
          planned_start_at: '2026-09-29T18:00',
          planned_end_at: '2026-09-29T08:00',
        },
        handler,
      ),
    ).rejects.toBeInstanceOf(TaskDatesIncoherentError);
    expect(insertTask).not.toHaveBeenCalled();
  });

  it('sin assignee_member_id no consulta si alguien es asignable', async () => {
    const handler = buildHandler();

    await run(baseCommand, handler);

    expect(handler.tenancyMock.isMemberAssignable).not.toHaveBeenCalled();
  });

  it('si reservar la mutación falla (id de otra organización), no inserta nada', async () => {
    vi.mocked(claimMutation).mockRejectedValue(new MutationIdReusedError());
    const handler = buildHandler();

    await expect(run(baseCommand, handler)).rejects.toBeInstanceOf(MutationIdReusedError);
    expect(insertTask).not.toHaveBeenCalled();
  });
  describe('avisos (ADR-019)', () => {
    it('una tarea que nace asignada avisa a su responsable, en la misma transacción', async () => {
      vi.mocked(insertTask).mockResolvedValue({
        ...insertedTask,
        assigneeMemberId: 'member_assignee',
      });
      const handler = buildHandler();

      await run({ ...baseCommand, assignee_member_id: 'member_assignee' }, handler);

      expect(handler.notificationsMock.notifyTaskAssigned).toHaveBeenCalledWith(
        {},
        {
          organizationId: tenant.organizationId,
          actorMemberId: tenant.memberId,
          recipientMemberId: 'member_assignee',
          taskId: insertedTask.id,
          projectId: insertedTask.projectId,
          taskTitle: insertedTask.title,
          taskVersion: insertedTask.version,
        },
      );
    });

    it('una tarea sin responsable no avisa a nadie', async () => {
      const handler = buildHandler();

      await run(baseCommand, handler);

      expect(handler.notificationsMock.notifyTaskAssigned).not.toHaveBeenCalled();
    });

    it('un reintento (la mutación ya estaba reservada) no avisa de nuevo', async () => {
      vi.mocked(claimMutation).mockResolvedValue({
        claimed: false,
        prior: {
          kind: 'task.create',
          entityId: baseCommand.id,
          result: 'applied',
          rejectionReason: null,
        },
      });
      vi.mocked(findTaskById).mockResolvedValue({
        ...insertedTask,
        assigneeMemberId: 'member_assignee',
      });
      const handler = buildHandler();

      await run({ ...baseCommand, assignee_member_id: 'member_assignee' }, handler);

      expect(handler.notificationsMock.notifyTaskAssigned).not.toHaveBeenCalled();
    });
  });
});
