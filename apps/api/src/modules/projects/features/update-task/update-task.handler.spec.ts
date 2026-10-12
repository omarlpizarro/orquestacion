import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import type { TenancyService } from '../../../tenancy/tenancy.module.js';
import { TaskDatesIncoherentError } from '../../domain/errors/task-dates-incoherent.error.js';
import { TaskEditCancelledError } from '../../domain/errors/task-edit-cancelled.error.js';
import { TaskEditForbiddenError } from '../../domain/errors/task-edit-forbidden.error.js';
import { TaskEditProjectAccessError } from '../../domain/errors/task-edit-project-access.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import {
  findProjectForTenant,
  findVisibleTask,
  type TaskRow,
  updateTaskFields,
} from '../../infrastructure/task.repository.js';
import type { ProjectAccessService } from '../../project-access.service.js';
import type { UpdateTaskCommand } from './update-task.command.js';
import { UpdateTaskHandler } from './update-task.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({ claimMutation: vi.fn() }));
vi.mock('../../infrastructure/task.repository.js', () => ({
  findVisibleTask: vi.fn(),
  findProjectForTenant: vi.fn(),
  updateTaskFields: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'manager' };

const baseCommand: UpdateTaskCommand = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  expected_version: 3,
};

const siteId = '01945f4e-0000-7000-8000-0000000000aa';
const projectId = '01945f4e-0000-7000-8000-0000000000bb';

const currentTask: TaskRow = {
  id: baseCommand.id,
  organizationId: tenant.organizationId,
  projectId,
  parentTaskId: null,
  depth: 1,
  title: 'Excavar',
  description: 'Cimientos',
  status: 'pending',
  criticality: 'normal',
  assigneeMemberId: null,
  plannedStartAt: '2026-10-20T11:00:00.000Z',
  plannedEndAt: '2026-10-21T11:00:00.000Z',
  isMilestone: false,
  ackRequired: false,
  position: 'a0',
  version: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
};

function buildHandler(options: { hasFullAccess?: boolean } = {}) {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const tenancy = { resolveTimezone: vi.fn().mockResolvedValue('America/Argentina/Buenos_Aires') };
  const hasFullAccess = vi.fn().mockResolvedValue(options.hasFullAccess ?? true);
  const handler = new UpdateTaskHandler(
    { withTenant } as unknown as TransactionService,
    tenancy as unknown as TenancyService,
    { hasFullAccess } as unknown as ProjectAccessService,
  );
  return { handler, tenancy, hasFullAccess };
}

const run = <T>(handler: UpdateTaskHandler, command = baseCommand, role = tenant.role) =>
  runWithRequestContext({ requestId: 'req-1', tenant: { ...tenant, role } }, () =>
    handler.execute(command),
  ) as Promise<T>;

describe('UpdateTaskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimMutation).mockResolvedValue({ claimed: true });
    vi.mocked(findVisibleTask).mockResolvedValue(currentTask);
    vi.mocked(findProjectForTenant).mockResolvedValue({ id: projectId, siteId });
    vi.mocked(updateTaskFields).mockImplementation(async (_tx, params) => ({
      ...currentTask,
      ...(params.changes.title !== undefined && { title: params.changes.title }),
      version: currentTask.version + 1,
    }));
  });

  it('reserva la mutación como primera sentencia, antes de leer la tarea (ADR-007)', async () => {
    const { handler } = buildHandler();

    await run(handler, { ...baseCommand, title: 'Excavar y nivelar' });

    expect(claimMutation).toHaveBeenCalledWith(
      {},
      {
        clientMutationId: baseCommand.client_mutation_id,
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        kind: 'task.update',
        entityId: baseCommand.id,
      },
    );
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(claimMutation)).toBeLessThan(order(findVisibleTask));
  });

  describe('quién edita (orden 404 → 403 → 409, ADR-017 §6)', () => {
    it('una tarea que quien pide no ve (RLS) es 404 antes de mirar el rol', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue(null);
      const { handler } = buildHandler();

      await expect(run(handler, { ...baseCommand, title: 'X' }, 'operator')).rejects.toBeInstanceOf(
        TaskNotFoundError,
      );
      expect(updateTaskFields).not.toHaveBeenCalled();
    });

    it.each(['owner', 'director', 'manager'])('%s con acceso completo edita', async (role) => {
      const { handler } = buildHandler();

      await run(handler, { ...baseCommand, title: 'Nuevo' }, role);

      expect(updateTaskFields).toHaveBeenCalled();
    });

    it('el operario no edita, ni su propia tarea: 403 sin consultar el acceso ni escribir', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue({
        ...currentTask,
        assigneeMemberId: tenant.memberId,
      });
      const { handler, hasFullAccess } = buildHandler();

      await expect(
        run(handler, { ...baseCommand, title: 'Mía' }, 'operator'),
      ).rejects.toBeInstanceOf(TaskEditForbiddenError);
      expect(hasFullAccess).not.toHaveBeenCalled();
      expect(updateTaskFields).not.toHaveBeenCalled();
    });

    it('un manager "solo asignado" (sin acceso completo al proyecto) recibe 403', async () => {
      const { handler } = buildHandler({ hasFullAccess: false });

      await expect(run(handler, { ...baseCommand, title: 'X' })).rejects.toBeInstanceOf(
        TaskEditProjectAccessError,
      );
      expect(updateTaskFields).not.toHaveBeenCalled();
    });

    it('la autorización va antes que la versión: quien no puede editar no se entera de que cambió', async () => {
      const { handler } = buildHandler();

      await expect(
        run(handler, { ...baseCommand, expected_version: 1, title: 'X' }, 'operator'),
      ).rejects.toBeInstanceOf(TaskEditForbiddenError);
    });
  });

  describe('tareas congeladas (ADR-012)', () => {
    it('una tarea cancelada responde 422 y no escribe, sea cual sea el pedido', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue({ ...currentTask, status: 'cancelled' });
      const { handler } = buildHandler();

      await expect(run(handler, { ...baseCommand, title: 'Nuevo' })).rejects.toBeInstanceOf(
        TaskEditCancelledError,
      );
      // Tampoco un pedido sin cambios reales.
      await expect(run(handler, { ...baseCommand, title: 'Excavar' })).rejects.toBeInstanceOf(
        TaskEditCancelledError,
      );
      expect(updateTaskFields).not.toHaveBeenCalled();
    });

    it('la regla va después de autorizar y antes de la versión', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue({ ...currentTask, status: 'cancelled' });
      const { handler } = buildHandler();

      // Sin permiso: 403, aunque esté cancelada (no se entera de su estado).
      await expect(run(handler, { ...baseCommand, title: 'X' }, 'operator')).rejects.toBeInstanceOf(
        TaskEditForbiddenError,
      );
      // Con permiso y una versión vieja: 422, no 409.
      await expect(
        run(handler, { ...baseCommand, expected_version: 1, title: 'X' }),
      ).rejects.toBeInstanceOf(TaskEditCancelledError);
    });

    it('una tarea done sí se edita: se puede reabrir', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue({ ...currentTask, status: 'done' });
      const { handler } = buildHandler();

      await run(handler, { ...baseCommand, title: 'Nuevo' });

      expect(updateTaskFields).toHaveBeenCalled();
    });
  });

  describe('concurrencia', () => {
    it('una versión vieja es 409 y no escribe', async () => {
      const { handler } = buildHandler();

      await expect(
        run(handler, { ...baseCommand, expected_version: 2, title: 'X' }),
      ).rejects.toBeInstanceOf(TaskVersionMismatchError);
      expect(updateTaskFields).not.toHaveBeenCalled();
    });

    it('si alguien gana la carrera entre la lectura y el UPDATE, también es 409', async () => {
      vi.mocked(updateTaskFields).mockResolvedValue(null);
      const { handler } = buildHandler();

      await expect(run(handler, { ...baseCommand, title: 'X' })).rejects.toBeInstanceOf(
        TaskVersionMismatchError,
      );
    });
  });

  describe('edición parcial', () => {
    it('manda solo los campos que cambian de verdad', async () => {
      const { handler } = buildHandler();

      await run(handler, { ...baseCommand, title: 'Nuevo', criticality: 'normal' });

      expect(updateTaskFields).toHaveBeenCalledWith(
        {},
        {
          organizationId: tenant.organizationId,
          taskId: baseCommand.id,
          expectedVersion: 3,
          changes: { title: 'Nuevo' },
        },
      );
    });

    it('un pedido sin cambios reales no escribe, no emite evento y devuelve la tarea como está', async () => {
      const listener = vi.fn();
      domainEvents.onEvent('task.updated', listener);
      const { handler } = buildHandler();

      const output = await run<{ version: number; title: string }>(handler, {
        ...baseCommand,
        title: 'Excavar',
        description: 'Cimientos',
        criticality: 'normal',
      });

      expect(updateTaskFields).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      expect(output).toMatchObject({ version: 3, title: 'Excavar' });
      domainEvents.removeListener('task.updated', listener);
    });

    it('emite task.updated con los campos que cambiaron, solo cuando cambia algo', async () => {
      const listener = vi.fn();
      domainEvents.onEvent('task.updated', listener);
      const { handler } = buildHandler();

      await run(handler, { ...baseCommand, title: 'Nuevo', criticality: 'high' });

      expect(listener).toHaveBeenCalledWith({
        taskId: baseCommand.id,
        organizationId: tenant.organizationId,
        projectId,
        changedFields: ['title', 'criticality'],
        requestId: 'req-1',
      });
      domainEvents.removeListener('task.updated', listener);
    });
  });

  describe('fechas (ADR-008)', () => {
    it('se interpretan en la zona horaria del sitio del proyecto', async () => {
      const { handler, tenancy } = buildHandler();

      await run(handler, { ...baseCommand, planned_start_at: '2026-10-20T09:00' });

      expect(tenancy.resolveTimezone).toHaveBeenCalledWith(
        {},
        { organizationId: tenant.organizationId, siteId },
      );
      // Buenos Aires es UTC-3.
      expect(vi.mocked(updateTaskFields).mock.calls[0]?.[1].changes).toEqual({
        plannedStartAt: '2026-10-20T12:00:00.000Z',
      });
    });

    it('null borra la fecha y no necesita la zona horaria', async () => {
      const { handler, tenancy } = buildHandler();

      await run(handler, { ...baseCommand, planned_end_at: null });

      expect(tenancy.resolveTimezone).not.toHaveBeenCalled();
      expect(vi.mocked(updateTaskFields).mock.calls[0]?.[1].changes).toEqual({
        plannedEndAt: null,
      });
    });

    it('sin fechas en el pedido no resuelve la zona horaria', async () => {
      const { handler, tenancy } = buildHandler();

      await run(handler, { ...baseCommand, title: 'Nuevo' });

      expect(tenancy.resolveTimezone).not.toHaveBeenCalled();
      expect(findProjectForTenant).not.toHaveBeenCalled();
    });

    it('un fin anterior al inicio es 422 y no escribe', async () => {
      const { handler } = buildHandler();

      await expect(
        run(handler, { ...baseCommand, planned_end_at: '2026-10-19T08:00' }),
      ).rejects.toBeInstanceOf(TaskDatesIncoherentError);
      expect(updateTaskFields).not.toHaveBeenCalled();
    });
  });

  describe('reintento (la mutación ya estaba reservada)', () => {
    beforeEach(() => {
      vi.mocked(claimMutation).mockResolvedValue({
        claimed: false,
        prior: {
          kind: 'task.update',
          entityId: baseCommand.id,
          result: 'applied',
          rejectionReason: null,
        },
      });
    });

    it('devuelve la tarea como está sin autorizar, comparar versión ni escribir, y sin evento', async () => {
      const listener = vi.fn();
      domainEvents.onEvent('task.updated', listener);
      const { handler, hasFullAccess } = buildHandler();

      const output = await run<{ id: string }>(handler, { ...baseCommand, title: 'Nuevo' });

      expect(output.id).toBe(baseCommand.id);
      expect(updateTaskFields).not.toHaveBeenCalled();
      expect(hasFullAccess).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      domainEvents.removeListener('task.updated', listener);
    });

    it('si ya no la ve, 404', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue(null);
      const { handler } = buildHandler();

      await expect(run(handler, { ...baseCommand, title: 'X' })).rejects.toBeInstanceOf(
        TaskNotFoundError,
      );
    });
  });
});
