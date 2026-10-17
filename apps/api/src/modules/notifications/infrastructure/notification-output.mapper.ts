import type { NotificationOutput } from '@orq/contracts';
import type { NotificationRow } from './notification.repository.js';

export function toNotificationOutput(row: NotificationRow): NotificationOutput {
  return {
    id: row.id,
    template_key: row.templateKey,
    task_id: row.taskId,
    project_id: row.projectId,
    payload: row.payload,
    created_at: row.createdAt,
    read_at: row.readAt,
  };
}
