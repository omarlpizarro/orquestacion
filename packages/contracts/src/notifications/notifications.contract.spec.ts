import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATIONS_PAGE_SIZE,
  listNotificationsInputSchema,
  listNotificationsOutputSchema,
  MAX_NOTIFICATIONS_PAGE_SIZE,
} from './list-notifications.contract.js';
import { markNotificationReadInputSchema } from './mark-notification-read.contract.js';

describe('listNotificationsInputSchema', () => {
  it('sin parámetros usa la página por defecto', () => {
    const parsed = listNotificationsInputSchema.parse({});
    expect(parsed.limit).toBe(DEFAULT_NOTIFICATIONS_PAGE_SIZE);
    expect(parsed.unread_only).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it('lee los parámetros de la query string, que llegan como texto', () => {
    const parsed = listNotificationsInputSchema.parse({ limit: '10', unread_only: 'true' });
    expect(parsed).toMatchObject({ limit: 10, unread_only: true });
    expect(listNotificationsInputSchema.parse({ unread_only: 'false' }).unread_only).toBe(false);
  });

  it('rechaza un limit fuera de rango o no entero', () => {
    for (const limit of ['0', String(MAX_NOTIFICATIONS_PAGE_SIZE + 1), '1.5', 'muchos']) {
      expect(listNotificationsInputSchema.safeParse({ limit }).success, limit).toBe(false);
    }
  });

  it('rechaza un unread_only que no sea true o false', () => {
    expect(listNotificationsInputSchema.safeParse({ unread_only: 'quizas' }).success).toBe(false);
  });
});

describe('listNotificationsOutputSchema', () => {
  const notification = {
    id: '01945f4e-0000-7000-8000-000000000001',
    template_key: 'task.assigned',
    task_id: '01945f4e-0000-7000-8000-000000000002',
    project_id: '01945f4e-0000-7000-8000-000000000003',
    payload: { task_title: 'Excavar', actor_member_id: 'member_1' },
    created_at: '2026-10-17T12:00:00.000Z',
    read_at: null,
  };

  it('acepta una página con avisos, cursor y contador', () => {
    const output = { notifications: [notification], next_cursor: null, unread_count: 1 };
    expect(listNotificationsOutputSchema.safeParse(output).success).toBe(true);
  });

  it('rechaza una plantilla desconocida', () => {
    const output = {
      notifications: [{ ...notification, template_key: 'task.inventada' }],
      next_cursor: null,
      unread_count: 0,
    };
    expect(listNotificationsOutputSchema.safeParse(output).success).toBe(false);
  });
});

describe('markNotificationReadInputSchema', () => {
  const valid = {
    client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
    id: '01945f4e-0000-7000-8000-000000000001',
  };

  it('acepta el pedido mínimo', () => {
    expect(markNotificationReadInputSchema.safeParse(valid).success).toBe(true);
  });

  it('exige client_mutation_id y un id UUIDv7', () => {
    const { client_mutation_id, ...withoutMutation } = valid;
    expect(markNotificationReadInputSchema.safeParse(withoutMutation).success).toBe(false);
    expect(
      markNotificationReadInputSchema.safeParse({ ...valid, id: 'no-es-un-uuid' }).success,
    ).toBe(false);
  });
});
