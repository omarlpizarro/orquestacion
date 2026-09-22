import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findPriorMutation, recordMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import type { TenancyService } from '../../../tenancy/tenancy.module.js';
import { ParentTaskNotFoundError } from '../../domain/errors/parent-task-not-found.error.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { TaskDepthExceededError } from '../../domain/errors/task-depth-exceeded.error.js';
import {
  findLastSiblingPosition,
  findParentTaskForTenant,
  findProjectForTenant,
  findTaskById,
  insertTask,
  type TaskRow,
} from '../../infrastructure/task.repository.js';
import type { CreateTaskCommand } from './create-task.command.js';
import { CreateTaskHandler } from './create-task.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({
  findPriorMutation: vi.fn(),
  recordMutation: vi.fn(),
}));
vi.mock('../../infrastructure/task.repository.js', () => ({
  findProjectForTenant: vi.fn(),
  findParentTaskForTenant: vi.fn(),
  findLastSiblingPosition: vi.fn(),
  insertTask: vi.fn(),
  findTaskById: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123' };

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
  path: '019450000000700080000000001'.replaceAll('-', ''),
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

function buildHandler() {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const transactions = { withTenant } as unknown as TransactionService;
  const tenancy = {
    resolveTimezone: vi.fn().mockResolvedValue('America/Argentina/Buenos_Aires'),
  } as unknown as TenancyService;
  return new CreateTaskHandler(transactions, tenancy);
}

function run<T>(command: CreateTaskCommand, handler: CreateTaskHandler): Promise<T> {
  return runWithRequestContext({ requestId: 'req-1', tenant }, () =>
    handler.execute(command),
  ) as Promise<T>;
}

describe('CreateTaskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findPriorMutation).mockResolvedValue(null);
    vi.mocked(findProjectForTenant).mockResolvedValue({ id: baseCommand.project_id, siteId: null });
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
      path: insertedTask.path,
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

  it('registra la mutación como aplicada dentro de la misma transacción', async () => {
    const handler = buildHandler();

    await run(baseCommand, handler);

    expect(recordMutation).toHaveBeenCalledWith(
      {},
      {
        clientMutationId: baseCommand.client_mutation_id,
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        kind: 'task.create',
        entityId: insertedTask.id,
        result: 'applied',
      },
    );
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

  it('reintento con el mismo client_mutation_id no vuelve a insertar', async () => {
    vi.mocked(findPriorMutation).mockResolvedValue({
      entityId: insertedTask.id,
      result: 'applied',
      rejectionReason: null,
    });
    vi.mocked(findTaskById).mockResolvedValue(insertedTask);
    const handler = buildHandler();

    const result = await run<{ id: string }>(baseCommand, handler);

    expect(result.id).toBe(insertedTask.id);
    expect(insertTask).not.toHaveBeenCalled();
    expect(recordMutation).not.toHaveBeenCalled();
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
});
