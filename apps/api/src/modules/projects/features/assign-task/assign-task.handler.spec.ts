import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import type { TenancyService } from '../../../tenancy/tenancy.module.js';
import { AssigneeNotAssignableError } from '../../domain/errors/assignee-not-assignable.error.js';
import { TaskAssignCancelledError } from '../../domain/errors/task-assign-cancelled.error.js';
import { TaskAssignForbiddenError } from '../../domain/errors/task-assign-forbidden.error.js';
import { TaskAssignProjectAccessError } from '../../domain/errors/task-assign-project-access.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { TaskVersionMismatchError } from '../../domain/errors/task-version-mismatch.error.js';
import {
  findProjectForTenant,
  findVisibleTask,
  type TaskRow,
  updateTaskAssignee,
} from '../../infrastructure/task.repository.js';
import type { ProjectAccessService } from '../../project-access.service.js';
import type { AssignTaskCommand } from './assign-task.command.js';
import { AssignTaskHandler } from './assign-task.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({ claimMutation: vi.fn() }));
vi.mock('../../infrastructure/task.repository.js', () => ({
  findVisibleTask: vi.fn(),
  findProjectForTenant: vi.fn(),
  updateTaskAssignee: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'manager' };

const baseCommand: AssignTaskCommand = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  expected_version: 3,
  assignee_member_id: 'member_nueva',
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
  description: null,
  status: 'pending',
  criticality: 'normal',
  assigneeMemberId: 'member_anterior',
  plannedStartAt: null,
  plannedEndAt: null,
  isMilestone: false,
  ackRequired: false,
  position: 'a0',
  version: 3,
  createdAt: '2026-10-01T00:00:00.000Z',
};

function buildHandler(options: { hasFullAccess?: boolean; assignable?: boolean } = {}) {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const tenancy = {
    isMemberAssignable: vi.fn().mockResolvedValue(options.assignable ?? true),
    isMemberInOrganization: vi.fn().mockResolvedValue(false),
  };
  const projectAccess = {
    hasFullAccess: vi.fn().mockResolvedValue(options.hasFullAccess ?? true),
    isExplicitMember: vi.fn().mockResolvedValue(false),
  };
  const handler = new AssignTaskHandler(
    { withTenant } as unknown as TransactionService,
    tenancy as unknown as TenancyService,
    projectAccess as unknown as ProjectAccessService,
  );
  return { handler, tenancy, projectAccess };
}

const run = <T>(handler: AssignTaskHandler, command = baseCommand, role = tenant.role) =>
  runWithRequestContext({ requestId: 'req-1', tenant: { ...tenant, role } }, () =>
    handler.execute(command),
  ) as Promise<T>;

describe('AssignTaskHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimMutation).mockResolvedValue({ claimed: true });
    vi.mocked(findVisibleTask).mockResolvedValue(currentTask);
    vi.mocked(findProjectForTenant).mockResolvedValue({ id: projectId, siteId });
    vi.mocked(updateTaskAssignee).mockImplementation(async (_tx, params) => ({
      ...currentTask,
      assigneeMemberId: params.assigneeMemberId,
      version: currentTask.version + 1,
    }));
  });

  it('reserva la mutación como primera sentencia, antes de leer la tarea (ADR-007)', async () => {
    const { handler } = buildHandler();

    await run(handler);

    expect(claimMutation).toHaveBeenCalledWith(
      {},
      {
        clientMutationId: baseCommand.client_mutation_id,
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        kind: 'task.assign',
        entityId: baseCommand.id,
      },
    );
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(claimMutation)).toBeLessThan(order(findVisibleTask));
  });

  it('asigna, valida contra el sitio del proyecto y emite task.assigned con el responsable anterior', async () => {
    const listener = vi.fn();
    domainEvents.onEvent('task.assigned', listener);
    const { handler, tenancy } = buildHandler();

    const output = await run<{ assignee_member_id: string | null; version: number }>(handler);

    expect(tenancy.isMemberAssignable).toHaveBeenCalledWith(
      {},
      { organizationId: tenant.organizationId, memberId: 'member_nueva', siteId },
    );
    expect(output).toMatchObject({ assignee_member_id: 'member_nueva', version: 4 });
    expect(listener).toHaveBeenCalledWith({
      taskId: baseCommand.id,
      organizationId: tenant.organizationId,
      projectId,
      assigneeMemberId: 'member_nueva',
      previousAssigneeMemberId: 'member_anterior',
      assignedByMemberId: tenant.memberId,
      requestId: 'req-1',
    });
    domainEvents.removeListener('task.assigned', listener);
  });

  it('null desasigna, sin validar a nadie', async () => {
    const { handler, tenancy } = buildHandler();

    const output = await run<{ assignee_member_id: string | null }>(handler, {
      ...baseCommand,
      assignee_member_id: null,
    });

    expect(output.assignee_member_id).toBeNull();
    expect(tenancy.isMemberAssignable).not.toHaveBeenCalled();
  });

  it('quien no es asignable (otra organización o sin acceso al sitio) es 422 y no escribe', async () => {
    const { handler } = buildHandler({ assignable: false });

    await expect(run(handler)).rejects.toBeInstanceOf(AssigneeNotAssignableError);
    expect(updateTaskAssignee).not.toHaveBeenCalled();
  });

  it('un miembro explícito del proyecto es asignable aunque no trabaje en el sitio', async () => {
    const { handler, tenancy, projectAccess } = buildHandler({ assignable: false });
    projectAccess.isExplicitMember.mockResolvedValue(true);
    tenancy.isMemberInOrganization.mockResolvedValue(true);

    await run(handler);

    expect(updateTaskAssignee).toHaveBeenCalled();
  });

  it('pedir el responsable que ya tiene no escribe, no valida y no emite evento', async () => {
    const listener = vi.fn();
    domainEvents.onEvent('task.assigned', listener);
    const { handler, tenancy } = buildHandler();

    const output = await run<{ version: number }>(handler, {
      ...baseCommand,
      assignee_member_id: 'member_anterior',
    });

    expect(output.version).toBe(3);
    expect(updateTaskAssignee).not.toHaveBeenCalled();
    expect(tenancy.isMemberAssignable).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
    domainEvents.removeListener('task.assigned', listener);
  });

  describe('quién asigna (orden 404 → 403 → dominio → 409, ADR-017 §6)', () => {
    it('una tarea que quien pide no ve es 404 antes de mirar el rol', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue(null);
      const { handler } = buildHandler();

      await expect(run(handler, baseCommand, 'operator')).rejects.toBeInstanceOf(TaskNotFoundError);
    });

    it.each(['owner', 'director', 'manager'])('%s con acceso completo asigna', async (role) => {
      const { handler } = buildHandler();

      await run(handler, baseCommand, role);

      expect(updateTaskAssignee).toHaveBeenCalled();
    });

    it('el operario no asigna, tampoco su propia tarea: 403 sin consultar el acceso', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue({
        ...currentTask,
        assigneeMemberId: tenant.memberId,
      });
      const { handler, projectAccess } = buildHandler();

      await expect(run(handler, baseCommand, 'operator')).rejects.toBeInstanceOf(
        TaskAssignForbiddenError,
      );
      expect(projectAccess.hasFullAccess).not.toHaveBeenCalled();
      expect(updateTaskAssignee).not.toHaveBeenCalled();
    });

    it('un manager "solo asignado" (sin acceso completo) recibe 403', async () => {
      const { handler } = buildHandler({ hasFullAccess: false });

      await expect(run(handler)).rejects.toBeInstanceOf(TaskAssignProjectAccessError);
    });

    it('una cancelada está congelada: 422, después de autorizar y antes de la versión', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue({ ...currentTask, status: 'cancelled' });
      const { handler } = buildHandler();

      await expect(run(handler, baseCommand, 'operator')).rejects.toBeInstanceOf(
        TaskAssignForbiddenError,
      );
      await expect(run(handler, { ...baseCommand, expected_version: 1 })).rejects.toBeInstanceOf(
        TaskAssignCancelledError,
      );
      expect(updateTaskAssignee).not.toHaveBeenCalled();
    });

    it('una done se puede reasignar: se puede reabrir', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue({ ...currentTask, status: 'done' });
      const { handler } = buildHandler();

      await run(handler);

      expect(updateTaskAssignee).toHaveBeenCalled();
    });

    it('la autorización va antes que la versión', async () => {
      const { handler } = buildHandler();

      await expect(
        run(handler, { ...baseCommand, expected_version: 1 }, 'operator'),
      ).rejects.toBeInstanceOf(TaskAssignForbiddenError);
    });
  });

  describe('concurrencia (en asignaciones gana el servidor, §9)', () => {
    it('una versión vieja es 409 y no escribe', async () => {
      const { handler } = buildHandler();

      await expect(run(handler, { ...baseCommand, expected_version: 2 })).rejects.toBeInstanceOf(
        TaskVersionMismatchError,
      );
      expect(updateTaskAssignee).not.toHaveBeenCalled();
    });

    it('si alguien gana la carrera entre la lectura y el UPDATE, también es 409', async () => {
      vi.mocked(updateTaskAssignee).mockResolvedValue(null);
      const { handler } = buildHandler();

      await expect(run(handler)).rejects.toBeInstanceOf(TaskVersionMismatchError);
    });
  });

  describe('reintento (la mutación ya estaba reservada)', () => {
    beforeEach(() => {
      vi.mocked(claimMutation).mockResolvedValue({
        claimed: false,
        prior: {
          kind: 'task.assign',
          entityId: baseCommand.id,
          result: 'applied',
          rejectionReason: null,
        },
      });
    });

    it('devuelve la tarea como está, sin autorizar, comparar versión, escribir ni emitir', async () => {
      const listener = vi.fn();
      domainEvents.onEvent('task.assigned', listener);
      const { handler, projectAccess } = buildHandler();

      const output = await run<{ id: string }>(handler);

      expect(output.id).toBe(baseCommand.id);
      expect(projectAccess.hasFullAccess).not.toHaveBeenCalled();
      expect(updateTaskAssignee).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
      domainEvents.removeListener('task.assigned', listener);
    });

    it('si ya no la ve, 404', async () => {
      vi.mocked(findVisibleTask).mockResolvedValue(null);
      const { handler } = buildHandler();

      await expect(run(handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    });
  });
});
