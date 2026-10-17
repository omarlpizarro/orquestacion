import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import { NotificationForbiddenError } from '../../domain/errors/notification-forbidden.error.js';
import { NotificationNotFoundError } from '../../domain/errors/notification-not-found.error.js';
import {
  findNotification,
  markNotificationRead,
  type NotificationRow,
} from '../../infrastructure/notification.repository.js';
import { MarkNotificationReadHandler } from './mark-notification-read.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({ claimMutation: vi.fn() }));
vi.mock('../../infrastructure/notification.repository.js', () => ({
  findNotification: vi.fn(),
  markNotificationRead: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'operator' };
const command = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
};

const unread: NotificationRow = {
  id: command.id,
  templateKey: 'task.assigned',
  taskId: '01945f4e-0000-7000-8000-000000000002',
  projectId: '01945f4e-0000-7000-8000-000000000003',
  payload: { task_title: 'Excavar', actor_member_id: 'member_otro' },
  createdAt: '2026-10-17T12:00:00.000Z',
  readAt: null,
};
const read: NotificationRow = { ...unread, readAt: '2026-10-17T13:00:00.000Z' };

function buildHandler() {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  return new MarkNotificationReadHandler({ withTenant } as unknown as TransactionService);
}

const run = (handler: MarkNotificationReadHandler, role = tenant.role) =>
  runWithRequestContext({ requestId: 'req-1', tenant: { ...tenant, role } }, () =>
    handler.execute(command),
  );

describe('MarkNotificationReadHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(claimMutation).mockResolvedValue({ claimed: true });
    vi.mocked(markNotificationRead).mockResolvedValue(read);
    vi.mocked(findNotification).mockResolvedValue(null);
  });

  it('reserva la mutación como primera sentencia (ADR-007)', async () => {
    await run(buildHandler());

    expect(claimMutation).toHaveBeenCalledWith(
      {},
      {
        clientMutationId: command.client_mutation_id,
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        kind: 'notification.mark-read',
        entityId: command.id,
      },
    );
    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(claimMutation)).toBeLessThan(order(markNotificationRead));
  });

  it('marca como leído un aviso propio sin leer y lo devuelve', async () => {
    const output = await run(buildHandler());

    expect(output).toMatchObject({ id: command.id, read_at: '2026-10-17T13:00:00.000Z' });
    expect(markNotificationRead).toHaveBeenCalledWith(
      {},
      {
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        notificationId: command.id,
      },
    );
  });

  it('uno ya leído se devuelve tal cual, con su read_at original', async () => {
    vi.mocked(markNotificationRead).mockResolvedValue(null);
    vi.mocked(findNotification).mockResolvedValue(read);

    const output = await run(buildHandler());

    expect(output.read_at).toBe(read.readAt);
  });

  it('un reintento (la mutación ya estaba reservada) no vuelve a escribir', async () => {
    vi.mocked(claimMutation).mockResolvedValue({
      claimed: false,
      prior: {
        kind: 'notification.mark-read',
        entityId: command.id,
        result: 'applied',
        rejectionReason: null,
      },
    });
    vi.mocked(findNotification).mockResolvedValue(read);

    const output = await run(buildHandler());

    expect(markNotificationRead).not.toHaveBeenCalled();
    expect(output.read_at).toBe(read.readAt);
  });

  it('404 si no existe o no es de quien pide (no se distingue)', async () => {
    vi.mocked(markNotificationRead).mockResolvedValue(null);
    vi.mocked(findNotification).mockResolvedValue(null);

    await expect(run(buildHandler())).rejects.toBeInstanceOf(NotificationNotFoundError);
  });

  it('un rol sin la capacidad no marca nada', async () => {
    await expect(run(buildHandler(), 'rol_inventado')).rejects.toBeInstanceOf(
      NotificationForbiddenError,
    );
    expect(claimMutation).not.toHaveBeenCalled();
  });

  it('lanza si no hay organización activa en el contexto', async () => {
    await expect(
      runWithRequestContext({ requestId: 'req-1' }, () => buildHandler().execute(command)),
    ).rejects.toThrow(/sesión con organización activa/);
  });
});
