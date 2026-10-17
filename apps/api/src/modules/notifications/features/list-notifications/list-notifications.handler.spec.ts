import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import { InvalidNotificationCursorError } from '../../domain/errors/invalid-notification-cursor.error.js';
import { NotificationForbiddenError } from '../../domain/errors/notification-forbidden.error.js';
import { encodeNotificationCursor } from '../../domain/notification-cursor.js';
import {
  countUnreadNotifications,
  listNotifications,
  type NotificationRow,
} from '../../infrastructure/notification.repository.js';
import { ListNotificationsHandler } from './list-notifications.handler.js';

vi.mock('../../infrastructure/notification.repository.js', () => ({
  listNotifications: vi.fn(),
  countUnreadNotifications: vi.fn(),
}));

const tenant = { organizationId: 'org_abc123', memberId: 'member_abc123', role: 'operator' };
const id = (n: number) => `01945f4e-0000-7000-8000-${String(n).padStart(12, '0')}`;

const row = (n: number): NotificationRow => ({
  id: id(n),
  templateKey: 'task.assigned',
  taskId: id(900 + n),
  projectId: id(800),
  payload: { task_title: `Tarea ${n}`, actor_member_id: 'member_otro' },
  createdAt: '2026-10-17T12:00:00.000Z',
  readAt: null,
});

function buildHandler() {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  return new ListNotificationsHandler({ withTenant } as unknown as TransactionService);
}

const run = (
  handler: ListNotificationsHandler,
  query: { limit?: number; cursor?: string; unread_only?: boolean } = {},
  role = tenant.role,
) =>
  runWithRequestContext({ requestId: 'req-1', tenant: { ...tenant, role } }, () =>
    handler.execute({ limit: 50, ...query }),
  );

describe('ListNotificationsHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listNotifications).mockResolvedValue([row(3), row(2), row(1)]);
    vi.mocked(countUnreadNotifications).mockResolvedValue(3);
  });

  it('lista los avisos de quien consulta, con el contador de no leídos', async () => {
    const output = await run(buildHandler());

    expect(output.notifications.map((n) => n.id)).toEqual([id(3), id(2), id(1)]);
    expect(output.unread_count).toBe(3);
    expect(output.next_cursor).toBeNull();
    expect(listNotifications).toHaveBeenCalledWith(
      {},
      {
        organizationId: tenant.organizationId,
        memberId: tenant.memberId,
        unreadOnly: false,
        afterId: null,
        limit: 51,
      },
    );
  });

  it('pide uno de más para saber si hay otra página, y el cursor es el último de la página', async () => {
    const output = await run(buildHandler(), { limit: 2 });

    expect(output.notifications.map((n) => n.id)).toEqual([id(3), id(2)]);
    expect(output.next_cursor).toBe(encodeNotificationCursor(id(2)));
    expect(listNotifications).toHaveBeenCalledWith({}, expect.objectContaining({ limit: 3 }));
  });

  it('pasa el cursor decodificado y el filtro de no leídos', async () => {
    await run(buildHandler(), { cursor: encodeNotificationCursor(id(2)), unread_only: true });

    expect(listNotifications).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ afterId: id(2), unreadOnly: true }),
    );
  });

  it('un cursor inválido se rechaza sin tocar la base', async () => {
    const handler = buildHandler();

    await expect(run(handler, { cursor: 'basura' })).rejects.toBeInstanceOf(
      InvalidNotificationCursorError,
    );
    expect(listNotifications).not.toHaveBeenCalled();
  });

  it('un rol sin la capacidad no lista nada', async () => {
    await expect(run(buildHandler(), {}, 'rol_inventado')).rejects.toBeInstanceOf(
      NotificationForbiddenError,
    );
    expect(listNotifications).not.toHaveBeenCalled();
  });

  it('lanza si no hay organización activa en el contexto', async () => {
    await expect(
      runWithRequestContext({ requestId: 'req-1' }, () => buildHandler().execute({ limit: 50 })),
    ).rejects.toThrow(/sesión con organización activa/);
  });
});
