import { assignedDedupeKey, blockedDedupeKey, REASON_PREVIEW_MAX_LENGTH } from '@orq/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { insertNotification, insertOutboxEntry } from './infrastructure/notification.repository.js';
import { NotificationsService } from './notifications.service.js';

vi.mock('./infrastructure/notification.repository.js', () => ({
  insertNotification: vi.fn().mockResolvedValue(undefined),
  insertOutboxEntry: vi.fn().mockResolvedValue(undefined),
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

  describe('notifyTaskBlockedToAssignee', () => {
    const blocked = {
      ...base,
      assigneeMemberId: 'member_responsable',
      taskUpdateId: '01945f4e-0000-7000-8000-0000000000aa',
      reason: 'Falta el permiso municipal',
    };

    it('avisa al responsable con el motivo y comparte la clave con el aviso del worker', async () => {
      await service.notifyTaskBlockedToAssignee(tx, blocked);

      expect(insertNotification).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          recipientMemberId: 'member_responsable',
          templateKey: 'task.blocked',
          payload: {
            task_title: 'Excavar',
            actor_member_id: base.actorMemberId,
            reason_preview: 'Falta el permiso municipal',
          },
          dedupeKey: blockedDedupeKey({
            taskUpdateId: blocked.taskUpdateId,
            recipientMemberId: 'member_responsable',
          }),
        }),
      );
    });

    it('no avisa al responsable si es quien bloqueó', async () => {
      await service.notifyTaskBlockedToAssignee(tx, {
        ...blocked,
        assigneeMemberId: base.actorMemberId,
      });

      expect(insertNotification).not.toHaveBeenCalled();
    });

    it('recorta un motivo largo en el extracto', async () => {
      await service.notifyTaskBlockedToAssignee(tx, { ...blocked, reason: 'x'.repeat(500) });

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
