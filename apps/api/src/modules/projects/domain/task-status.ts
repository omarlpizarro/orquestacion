import type { TaskOutput } from '@orq/contracts';

export type TaskStatus = TaskOutput['status'];

/**
 * Motivo que una transición puede exigir de quien la pide (ver
 * `TaskStatusTransition.requiresReason`). Es un concepto de dominio —
 * "esta transición necesita que alguien explique por qué" — independiente
 * de cómo lo persiste el handler: `'block_report'` y `'reopen'` son valores
 * reales de `task_update.kind` (`0006_collaboration.sql` y
 * `0007_task_update_reopen_kind.sql`).
 */
export type ReasonKind = 'block_report' | 'reopen';
