import type { TaskOutput } from '@orq/contracts';
import type { TaskRow } from './task.repository.js';

/**
 * Único lugar que traduce `TaskRow` (forma interna, la que devuelve el
 * repositorio) a `TaskOutput` (forma pública del contrato) — antes vivía
 * duplicado en `create-task.handler.ts` y `change-task-status.handler.ts`.
 * Cualquier feature nueva que devuelva una tarea (por ejemplo, "Mi Día")
 * importa esto en vez de escribir su propia copia.
 */
export function toTaskOutput(task: TaskRow): TaskOutput {
  return {
    id: task.id,
    project_id: task.projectId,
    parent_task_id: task.parentTaskId,
    depth: task.depth,
    title: task.title,
    description: task.description,
    status: task.status as TaskOutput['status'],
    criticality: task.criticality as TaskOutput['criticality'],
    assignee_member_id: task.assigneeMemberId,
    planned_start_at: task.plannedStartAt,
    planned_end_at: task.plannedEndAt,
    is_milestone: task.isMilestone,
    ack_required: task.ackRequired,
    position: task.position,
    version: task.version,
    created_at: task.createdAt,
  };
}
