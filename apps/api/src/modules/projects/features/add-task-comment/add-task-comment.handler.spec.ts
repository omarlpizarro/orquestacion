import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { MutationIdReusedError } from '../../../../shared/errors/mutation-id-reused.error.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import type {
  CollaborationService,
  TaskUpdateDetail,
} from '../../../collaboration/collaboration.module.js';
import { TaskCommentIdTakenError } from '../../domain/errors/task-comment-id-taken.error.js';
import { TaskNotFoundError } from '../../domain/errors/task-not-found.error.js';
import { findVisibleTask, type TaskRow } from '../../infrastructure/task.repository.js';
import type { AddTaskCommentCommand } from './add-task-comment.command.js';
import { AddTaskCommentHandler } from './add-task-comment.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({ claimMutation: vi.fn() }));
vi.mock('../../infrastructure/task.repository.js', () => ({ findVisibleTask: vi.fn() }));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'operator' };

const command: AddTaskCommentCommand = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  task_id: '01945f4e-0000-7000-8000-000000000001',
  id: '01945f4e-0000-7000-8000-000000000002',
  body: 'Llegó el camión',
};

const task = { id: command.task_id, projectId: '01945f4e-0000-7000-8000-0000000000aa' } as TaskRow;

const comment: TaskUpdateDetail = {
  id: command.id,
  taskId: command.task_id,
  kind: 'comment',
  body: command.body,
  metadata: {},
  createdByMemberId: tenant.memberId,
  createdAt: '2026-10-13T12:00:00.000Z',
};

function buildHandler() {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const collaboration = {
    createTaskUpdate: vi.fn().mockResolvedValue(comment),
    findTaskUpdate: vi.fn().mockResolvedValue(comment),
  };
  const handler = new AddTaskCommentHandler(
    { withTenant } as unknown as TransactionService,
    collaboration as unknown as CollaborationService,
  );
  return { handler, collaboration };
}

const run = <T>(handler: AddTaskCommentHandler, cmd = command) =>
  runWithRequestContext({ requestId: 'req-1', tenant }, () => handler.execute(cmd)) as Promise<T>;

describe('AddTaskCommentHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimMutation).mockResolvedValue({ claimed: true });
    vi.mocked(findVisibleTask).mockResolvedValue(task);
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
        kind: 'task.comment',
        entityId: command.id,
      },
    );
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(claimMutation)).toBeLessThan(order(findVisibleTask));
  });

  it('crea una novedad de tipo comment, con el autor del pedido, y devuelve su forma pública', async () => {
    const { handler, collaboration } = buildHandler();

    const output = await run<Record<string, unknown>>(handler);

    expect(collaboration.createTaskUpdate).toHaveBeenCalledWith(
      {},
      {
        id: command.id,
        organizationId: tenant.organizationId,
        createdByMemberId: tenant.memberId,
        taskId: command.task_id,
        kind: 'comment',
        body: command.body,
      },
    );
    expect(output).toEqual({
      id: command.id,
      task_id: command.task_id,
      kind: 'comment',
      body: command.body,
      metadata: {},
      created_by_member_id: tenant.memberId,
      created_at: comment.createdAt,
    });
  });

  it('una tarea que quien comenta no ve (RLS) es 404 y no inserta nada', async () => {
    vi.mocked(findVisibleTask).mockResolvedValue(null);
    const { handler, collaboration } = buildHandler();

    await expect(run(handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    expect(collaboration.createTaskUpdate).not.toHaveBeenCalled();
  });

  it('emite task.commented solo cuando crea, no en el reintento', async () => {
    const listener = vi.fn();
    domainEvents.onEvent('task.commented', listener);
    const { handler } = buildHandler();

    await run(handler);
    vi.mocked(claimMutation).mockResolvedValue({
      claimed: false,
      prior: {
        kind: 'task.comment',
        entityId: command.id,
        result: 'applied',
        rejectionReason: null,
      },
    });
    await run(handler);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      taskId: command.task_id,
      commentId: command.id,
      organizationId: tenant.organizationId,
      projectId: task.projectId,
      authorMemberId: tenant.memberId,
      requestId: 'req-1',
    });
    domainEvents.removeListener('task.commented', listener);
  });

  describe('reintento (la mutación ya estaba reservada)', () => {
    beforeEach(() => {
      vi.mocked(claimMutation).mockResolvedValue({
        claimed: false,
        prior: {
          kind: 'task.comment',
          entityId: command.id,
          result: 'applied',
          rejectionReason: null,
        },
      });
    });

    it('devuelve la novedad ya creada sin leer la tarea ni insertar', async () => {
      const { handler, collaboration } = buildHandler();

      const output = await run<{ id: string }>(handler);

      expect(output.id).toBe(command.id);
      expect(findVisibleTask).not.toHaveBeenCalled();
      expect(collaboration.createTaskUpdate).not.toHaveBeenCalled();
    });

    it('si la novedad ya no se ve, 404', async () => {
      const { handler, collaboration } = buildHandler();
      collaboration.findTaskUpdate.mockResolvedValue(null);

      await expect(run(handler)).rejects.toBeInstanceOf(TaskNotFoundError);
    });

    it('mismo id de mutación y de novedad pero para otra tarea: no es un reintento', async () => {
      const { handler, collaboration } = buildHandler();
      collaboration.findTaskUpdate.mockResolvedValue({
        ...comment,
        taskId: '01945f4e-0000-7000-8000-0000000000bb',
      });

      await expect(run(handler)).rejects.toBeInstanceOf(MutationIdReusedError);
    });
  });

  it('un id de novedad reusado con otra mutación se informa como TaskCommentIdTakenError', async () => {
    const { handler, collaboration } = buildHandler();
    collaboration.createTaskUpdate.mockRejectedValue(
      Object.assign(new Error('Failed query'), {
        cause: { code: '23505', constraint: 'task_update_pkey' },
      }),
    );

    await expect(run(handler)).rejects.toBeInstanceOf(TaskCommentIdTakenError);
  });

  it('cualquier otro error de la base se relanza tal cual', async () => {
    const { handler, collaboration } = buildHandler();
    const boom = Object.assign(new Error('otra cosa'), {
      cause: { code: '23505', constraint: 'x' },
    });
    collaboration.createTaskUpdate.mockRejectedValue(boom);

    await expect(run(handler)).rejects.toBe(boom);
  });
});
