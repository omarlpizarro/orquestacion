import { assignedDedupeKey, blockedDedupeKey, REASON_PREVIEW_MAX_LENGTH } from '@orq/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insertNotification, insertOutboxEntry } from './infrastructure/notification.repository.js';
import { NotificationsService } from './notifications.service.js';

vi.mock('./infrastructure/notification.repository.js', () => ({
  insertNotification: vi.fn().mockResolvedValue(undefined),
  insertOutboxEntry: vi.fn().mockResolvedValue(undefined),
  findPendingOutboxEntries: vi.fn().mockResolvedValue([]),
  claimOutboxEntry: vi.fn().mockResolvedValue(null),
  markOutboxEntryProcessed: vi.fn().mockResolvedValue(undefined),
  recordOutboxFailure: vi.fn().mockResolvedValue(1),
}));

const tx = {} as never;
const base = {
  organizationId: 'org_abc123',
  actorMemberId: 'member_actor',
  taskId: '01945f4e-0000-7000-8000-000000000001',
  projectId: '01945f4e-0000-7000-8000-000000000002',
  taskTitle: 'Excavar',
};

describe('NotificationsService', () => {
  const service = new NotificationsService();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('notifyTaskAssigned', () => {
    it('crea el aviso de asignación con la clave de deduplicación de la versión asignada', async () => {
      await service.notifyTaskAssigned(tx, {
        ...base,
        recipientMemberId: 'member_destino',
        taskVersion: 4,
      });

      expect(insertNotification).toHaveBeenCalledTimes(1);
      expect(insertNotification).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          organizationId: base.organizationId,
          createdByMemberId: base.actorMemberId,
          recipientMemberId: 'member_destino',
          taskId: base.taskId,
          projectId: base.projectId,
          templateKey: 'task.assigned',
          payload: { task_title: 'Excavar', actor_member_id: base.actorMemberId },
          dedupeKey: assignedDedupeKey({
            taskId: base.taskId,
            recipientMemberId: 'member_destino',
            taskVersion: 4,
          }),
        }),
      );
    });

    it('no avisa a quien se asigna a sí mismo', async () => {
      await service.notifyTaskAssigned(tx, {
        ...base,
        recipientMemberId: base.actorMemberId,
        taskVersion: 2,
      });

      expect(insertNotification).not.toHaveBeenCalled();
    });

    it('cada aviso lleva un id propio (UUIDv7)', async () => {
      await service.notifyTaskAssigned(tx, { ...base, recipientMemberId: 'a', taskVersion: 1 });
      await service.notifyTaskAssigned(tx, { ...base, recipientMemberId: 'b', taskVersion: 1 });

      const ids = vi.mocked(insertNotification).mock.calls.map((call) => call[1].id);
      expect(new Set(ids).size).toBe(2);
      expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-7/.test(id))).toBe(true);
    });
  });

  describe('notifyTaskBlocked', () => {
    const blocked = {
      ...base,
      recipientMemberIds: ['member_a', 'member_b'],
      taskUpdateId: '01945f4e-0000-7000-8000-0000000000aa',
      reason: 'Falta el permiso municipal',
    };

    it('crea un aviso por destinatario, con el motivo y la clave que comparte con el worker', async () => {
      await service.notifyTaskBlocked(tx, blocked);

      expect(insertNotification).toHaveBeenCalledTimes(2);
      for (const recipientMemberId of ['member_a', 'member_b']) {
        expect(insertNotification).toHaveBeenCalledWith(
          tx,
          expect.objectContaining({
            recipientMemberId,
            templateKey: 'task.blocked',
            payload: {
              task_title: 'Excavar',
              actor_member_id: base.actorMemberId,
              reason_preview: 'Falta el permiso municipal',
            },
            dedupeKey: blockedDedupeKey({ taskUpdateId: blocked.taskUpdateId, recipientMemberId }),
          }),
        );
      }
    });

    it('no avisa a quien bloqueó aunque venga en la lista', async () => {
      await service.notifyTaskBlocked(tx, {
        ...blocked,
        recipientMemberIds: [base.actorMemberId, 'member_a'],
      });

      const recipients = vi
        .mocked(insertNotification)
        .mock.calls.map((c) => c[1].recipientMemberId);
      expect(recipients).toEqual(['member_a']);
    });

    it('sin destinatarios no escribe nada', async () => {
      await service.notifyTaskBlocked(tx, { ...blocked, recipientMemberIds: [] });

      expect(insertNotification).not.toHaveBeenCalled();
    });

    it('sin motivo no lleva extracto', async () => {
      await service.notifyTaskBlocked(tx, { ...blocked, reason: null });

      const payload = vi.mocked(insertNotification).mock.calls[0]?.[1].payload;
      expect(payload).toEqual({ task_title: 'Excavar', actor_member_id: base.actorMemberId });
    });

    it('recorta un motivo largo en el extracto', async () => {
      await service.notifyTaskBlocked(tx, { ...blocked, reason: 'x'.repeat(500) });

      const payload = vi.mocked(insertNotification).mock.calls[0]?.[1].payload;
      expect(payload?.reason_preview?.length).toBeLessThanOrEqual(REASON_PREVIEW_MAX_LENGTH);
    });
  });

  describe('enqueueTaskBlockedFanout', () => {
    it('deja en la bandeja solo el tipo y el id de la novedad', async () => {
      await service.enqueueTaskBlockedFanout(tx, {
        organizationId: base.organizationId,
        actorMemberId: base.actorMemberId,
        taskUpdateId: '01945f4e-0000-7000-8000-0000000000aa',
      });

      expect(insertOutboxEntry).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          organizationId: base.organizationId,
          createdByMemberId: base.actorMemberId,
          kind: 'task.blocked',
          entityId: '01945f4e-0000-7000-8000-0000000000aa',
        }),
      );
    });
  });
});
