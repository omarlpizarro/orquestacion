import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import { TaskDeleteForbiddenError } from '../../domain/errors/task-delete-forbidden.error.js';
import { TaskDeleteProjectAccessError } from '../../domain/errors/task-delete-project-access.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import {
  findDeletedTaskSummary,
  findVisibleTask,
  lockTaskSubtree,
  softDeleteTaskSubtree,
  type TaskRow,
} from '../../infrastructure/task.repository.js';
import type { ProjectAccessService } from '../../project-access.service.js';
import type { DeleteTaskCommand } from './delete-task.command.js';
import { DeleteTaskHandler } from './delete-task.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({ claimMutation: vi.fn() }));
vi.mock('../../infrastructure/task.repository.js', () => ({
  findVisibleTask: vi.fn(),
  lockTaskSubtree: vi.fn(),
  softDeleteTaskSubtree: vi.fn(),
  findDeletedTaskSummary: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'manager' };

const command: DeleteTaskCommand = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  expected_version: 3,
};

const projectId = '01945f4e-0000-7000-8000-0000000000bb';

const currentTask = {
  id: command.id,
  projectId,
  version: 3,
  status: 'pending',
} as TaskRow;

function buildHandler(options: { hasFullAccess?: boolean } = {}) {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const hasFullAccess = vi.fn().mockResolvedValue(options.hasFullAccess ?? true);
  const handler = new DeleteTaskHandler(
    { withTenant } as unknown as TransactionService,
    { hasFullAccess } as unknown as ProjectAccessService,
  );
  return { handler, hasFullAccess };
}

const run = <T>(handler: DeleteTaskHandler, cmd = command, role = tenant.role) =>
  runWithRequestContext({ requestId: 'req-1', tenant: { ...tenant, role } }, () =>
    handler.execute(cmd),
  ) as Promise<T>;

describe('DeleteTaskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimMutation).mockResolvedValue({ claimed: true });
    vi.mocked(findVisibleTask).mockResolvedValue(currentTask);
    vi.mocked(lockTaskSubtree).mockResolvedValue([
      { id: command.id, version: 3 },
      { id: 'hija-1', version: 1 },
      { id: 'hija-2', version: 4 },
    ]);
    vi.mocked(softDeleteTaskSubtree).mockResolvedValue({
      count: 3,
      deletedAt: '2026-10-14T12:00:00.000Z',
    });
  });

  it('reserva la mutación como primera sentencia, antes de leer la tarea (ADR-007)', async () => {
    const { handler } = buildHandler();

    await run(handler);

    expect(claimMutation).toHaveBeenCalledWith(
      {},
      {
        clientMutationId: command.client_mutation_id,
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        kind: 'task.delete',
        entityId: command.id,
      },
    );
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(claimMutation)).toBeLessThan(order(findVisibleTask));
  });

  it('bloquea el árbol antes de borrar y devuelve cuántas tareas se borraron y cuándo', async () => {
    const { handler } = buildHandler();

    const output = await run<Record<string, unknown>>(handler);

    expect(output).toEqual({
      id: command.id,
      deleted_at: '2026-10-14T12:00:00.000Z',
      deleted_task_count: 3,
    });
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(lockTaskSubtree)).toBeLessThan(order(softDeleteTaskSubtree));
  });

  it('emite task.deleted con la cantidad, solo cuando borra', async () => {
    const listener = vi.fn();
    domainEvents.onEvent('task.deleted', listener);
    const { handler } = buildHandler();

    await run(handler);

    expect(listener).toHaveBeenCalledWith({
      taskId: command.id,
      organizationId: tenant.organizationId,
      projectId,
      deletedTaskCount: 3,
      deletedByMemberId: tenant.memberId,
      requestId: 'req-1',
    });
    domainEvents.removeListener('task.deleted', listener);
  });

  describe('quién borra (orden 404 → 403 → 409, ADR-017 §6)', () => {
    it('una tarea que quien pide no ve (RLS) es 404 antes de mirar el rol', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue(null);
      const { handler } = buildHandler();

      await expect(run(handler, command, 'operator')).rejects.toBeInstanceOf(TaskNotFoundError);
      expect(softDeleteTaskSubtree).not.toHaveBeenCalled();
    });

    it.each(['owner', 'director', 'manager'])('%s con acceso completo borra', async (role) => {
      const { handler } = buildHandler();

      await run(handler, command, role);

      expect(softDeleteTaskSubtree).toHaveBeenCalled();
    });

    it('el operario no borra, tampoco su propia tarea: 403 sin consultar el acceso ni bloquear', async () => {
      const { handler, hasFullAccess } = buildHandler();

      await expect(run(handler, command, 'operator')).rejects.toBeInstanceOf(
        TaskDeleteForbiddenError,
      );
      expect(hasFullAccess).not.toHaveBeenCalled();
      expect(lockTaskSubtree).not.toHaveBeenCalled();
    });

    it('un manager "solo asignado" (sin acceso completo) recibe 403', async () => {
      const { handler } = buildHandler({ hasFullAccess: false });

      await expect(run(handler)).rejects.toBeInstanceOf(TaskDeleteProjectAccessError);
      expect(softDeleteTaskSubtree).not.toHaveBeenCalled();
    });

    it('la autorización va antes que la versión', async () => {
      const { handler } = buildHandler();

      await expect(
        run(handler, { ...command, expected_version: 1 }, 'operator'),
      ).rejects.toBeInstanceOf(TaskDeleteForbiddenError);
    });
  });

  describe('concurrencia', () => {
    it('una versión vieja es 409 y no bloquea ni borra', async () => {
      const { handler } = buildHandler();

      await expect(run(handler, { ...command, expected_version: 2 })).rejects.toBeInstanceOf(
        TaskVersionMismatchError,
      );
      expect(lockTaskSubtree).not.toHaveBeenCalled();
      expect(softDeleteTaskSubtree).not.toHaveBeenCalled();
    });

    it('si la tarea cambió entre la lectura y el bloqueo, también es 409 y no borra', async () => {
      vi.mocked(lockTaskSubtree).mockResolvedValue([
        { id: command.id, version: 4 },
        { id: 'hija-1', version: 1 },
      ]);
      const { handler } = buildHandler();

      await expect(run(handler)).rejects.toBeInstanceOf(TaskVersionMismatchError);
      expect(softDeleteTaskSubtree).not.toHaveBeenCalled();
    });

    it('si otro borró la tarea entre la lectura y el bloqueo, 404', async () => {
      vi.mocked(lockTaskSubtree).mockResolvedValue([]);
      const { handler } = buildHandler();

      await expect(run(handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    });
  });

  describe('reintento (la mutación ya estaba reservada)', () => {
    beforeEach(() => {
      vi.mocked(claimMutation).mockResolvedValue({
        claimed: false,
        prior: {
          kind: 'task.delete',
          entityId: command.id,
          result: 'applied',
          rejectionReason: null,
        },
      });
    });

    it('reconstruye la respuesta de lo que quedó en la base, sin autorizar ni borrar ni emitir', async () => {
      vi.mocked(findDeletedTaskSummary).mockResolvedValue({
        deletedAt: '2026-10-14T12:00:00.000Z',
        count: 3,
      });
      const listener = vi.fn();
      domainEvents.onEvent('task.deleted', listener);
      const { handler, hasFullAccess } = buildHandler();

      const output = await run<Record<string, unknown>>(handler);

      expect(output).toEqual({
        id: command.id,
        deleted_at: '2026-10-14T12:00:00.000Z',
        deleted_task_count: 3,
      });
      expect(hasFullAccess).not.toHaveBeenCalled();
      expect(softDeleteTaskSubtree).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      domainEvents.removeListener('task.deleted', listener);
    });

    it('si quien reintenta ya no ve la tarea, 404', async () => {
      vi.mocked(findDeletedTaskSummary).mockResolvedValue(null);
      const { handler } = buildHandler();

      await expect(run(handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    });
  });
});
