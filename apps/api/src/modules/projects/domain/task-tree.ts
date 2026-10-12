export interface TaskTreeRow {
  id: string;
  parentTaskId: string | null;
  /** Orden manual entre hermanas: indexación fraccionaria en texto (CLAUDE.md §6). */
  position: string;
}

export type TaskTreeNode<Row extends TaskTreeRow> = Row & { subtasks: Array<TaskTreeNode<Row>> };

/**
 * Orden entre hermanas: `position` comparado por unidad de código (el orden de la
 * indexación fraccionaria, igual que `COLLATE "C"` en la base) y, a igualdad, el
 * `id` (UUIDv7: cronológico), para que el resultado sea determinista.
 */
function compareSiblings(a: TaskTreeRow, b: TaskTreeRow): number {
  if (a.position !== b.position) return a.position < b.position ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * Arma el árbol de subtareas a partir de las filas que quien lee puede ver.
 *
 * `rootParentId` es el padre de las raíces del árbol: `null` para las tareas raíz de
 * un proyecto, o el id de la tarea pedida cuando se arma el subárbol de una tarea.
 * Una fila cuyo padre NO está entre las filas (porque quien lee no lo ve: el nivel
 * "solo asignado" de ADR-017 §1 ve únicamente sus propias tareas, o porque el tope
 * recortó la lista) cuelga de la raíz, con su `parentTaskId` real y después de las
 * hijas propias: perderla sería esconderle a alguien una tarea que sí puede ver.
 * Las hermanas van por `position`.
 */
export function buildTaskTree<Row extends TaskTreeRow>(
  rows: readonly Row[],
  rootParentId: string | null = null,
): Array<TaskTreeNode<Row>> {
  const nodes = new Map<string, TaskTreeNode<Row>>(
    rows.map((row) => [row.id, { ...row, subtasks: [] }]),
  );

  const direct: Array<TaskTreeNode<Row>> = [];
  const orphans: Array<TaskTreeNode<Row>> = [];
  for (const node of nodes.values()) {
    const parent = node.parentTaskId;
    if (parent === rootParentId) {
      direct.push(node);
      continue;
    }
    const parentNode = parent === null ? undefined : nodes.get(parent);
    if (parentNode) parentNode.subtasks.push(node);
    else orphans.push(node);
  }

  const sortRecursively = (siblings: Array<TaskTreeNode<Row>>) => {
    siblings.sort(compareSiblings);
    for (const sibling of siblings) sortRecursively(sibling.subtasks);
  };
  sortRecursively(direct);
  sortRecursively(orphans);
  // Las huérfanas van después de las hijas propias: su `position` es relativa a
  // hermanas que quien lee no ve, así que no tiene sentido intercalarlas.
  const roots = [...direct, ...orphans];
  return roots;
}
