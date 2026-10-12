import type { TaskTreeNode as TaskTreeNodeOutput } from '@orq/contracts';
import type { TaskTreeNode } from '../domain/task-tree.js';
import type { TaskRow } from './task.repository.js';
import { toTaskOutput } from './task-output.mapper.js';

/**
 * El árbol del dominio no tiene tope de niveles en el tipo; el contrato sí (tres,
 * `MAX_TASK_DEPTH`). El dominio nunca produce más (`task-tree.spec.ts` lo vigila),
 * por eso el cast al tipo del contrato.
 */
export function toTaskTreeOutput(nodes: Array<TaskTreeNode<TaskRow>>): TaskTreeNodeOutput[] {
  return nodes.map((node) => ({
    ...toTaskOutput(node),
    subtasks: toTaskTreeOutput(node.subtasks),
  })) as TaskTreeNodeOutput[];
}
