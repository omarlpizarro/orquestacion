import { taskTreeNodeSchema } from '@orq/contracts';
import { describe, expect, it } from 'vitest';
import { MAX_TASK_DEPTH } from './max-task-depth.js';
import { buildTaskTree, type TaskTreeNode, type TaskTreeRow } from './task-tree.js';

const row = (id: string, parentTaskId: string | null, position: string): TaskTreeRow => ({
  id,
  parentTaskId,
  position,
});

const shape = (nodes: Array<TaskTreeNode<TaskTreeRow>>): unknown[] =>
  nodes.map((node) => (node.subtasks.length > 0 ? [node.id, shape(node.subtasks)] : node.id));

describe('buildTaskTree', () => {
  it('arma el árbol y ordena a las hermanas por position, a igualdad por id', () => {
    const tree = buildTaskTree([
      row('b', null, 'a1'),
      row('a', null, 'a0'),
      row('a2', 'a', 'a1'),
      row('a1', 'a', 'a0'),
      row('a1x', 'a1', 'a0'),
      row('c2', null, 'a2'),
      row('c1', null, 'a2'),
    ]);

    expect(shape(tree)).toEqual([['a', [['a1', ['a1x']], 'a2']], 'b', 'c1', 'c2']);
  });

  it('compara position por unidad de código, no por locale: las mayúsculas van antes que las minúsculas', () => {
    const tree = buildTaskTree([row('lower', null, 'a0'), row('upper', null, 'Zz')]);

    expect(shape(tree)).toEqual(['upper', 'lower']);
  });

  it('una fila cuyo padre no está entre las visibles cuelga de la raíz con su parentTaskId real, después de las propias', () => {
    // Quien tiene "solo asignado" ve una subtarea pero no la tarea de arriba.
    const tree = buildTaskTree([row('hija', 'padre-invisible', 'a0'), row('suelta', null, 'a1')]);

    expect(shape(tree)).toEqual(['suelta', 'hija']);
    expect(tree[1]?.parentTaskId).toBe('padre-invisible');
  });

  it('una huérfana conserva a sus propias hijas visibles', () => {
    const tree = buildTaskTree([row('hija', 'invisible', 'a0'), row('nieta', 'hija', 'a0')]);

    expect(shape(tree)).toEqual([['hija', ['nieta']]]);
  });

  it('en el subárbol de una tarea, las hijas directas son la raíz y las huérfanas cuelgan de ahí', () => {
    const tree = buildTaskTree(
      [
        row('h1', 'X', 'a0'),
        row('h2', 'X', 'a1'),
        row('n1', 'h1', 'a0'),
        row('nieta-de-Z', 'Z', 'a0'),
      ],
      'X',
    );

    expect(shape(tree)).toEqual([['h1', ['n1']], 'h2', 'nieta-de-Z']);
  });

  it('sin filas, árbol vacío', () => {
    expect(buildTaskTree([])).toEqual([]);
  });

  it('no repite ni pierde filas', () => {
    const rows = [
      row('a', null, 'a0'),
      row('b', 'a', 'a0'),
      row('c', 'b', 'a0'),
      row('d', 'zz', 'a0'),
    ];
    const count = (nodes: Array<TaskTreeNode<TaskTreeRow>>): number =>
      nodes.reduce((total, node) => total + 1 + count(node.subtasks), 0);

    expect(count(buildTaskTree(rows))).toBe(rows.length);
  });
});

/**
 * El contrato declara el árbol con tres niveles explícitos (no es recursivo): si
 * `MAX_TASK_DEPTH` cambia, el contrato tiene que cambiar con él.
 */
describe('el contrato del árbol y MAX_TASK_DEPTH', () => {
  const task = (id: string, depth: number) => ({
    id,
    project_id: '01945f4e-0000-7000-8000-0000000000aa',
    parent_task_id: null,
    depth,
    title: 'T',
    description: null,
    status: 'pending',
    criticality: 'normal',
    assignee_member_id: null,
    planned_start_at: null,
    planned_end_at: null,
    is_milestone: false,
    ack_required: false,
    position: 'a0',
    version: 1,
    created_at: '2026-10-13T12:00:00.000Z',
  });
  const id = (n: number) => `01945f4e-0000-7000-8000-00000000000${n}`;

  it('el árbol más profundo permitido valida contra el contrato', () => {
    expect(MAX_TASK_DEPTH).toBe(3);
    const deepest = {
      ...task(id(1), 1),
      subtasks: [{ ...task(id(2), 2), subtasks: [{ ...task(id(3), 3), subtasks: [] }] }],
    };

    expect(taskTreeNodeSchema.safeParse(deepest).success).toBe(true);
  });

  it('un cuarto nivel no valida: el dominio nunca lo produce', () => {
    const tooDeep = {
      ...task(id(1), 1),
      subtasks: [
        {
          ...task(id(2), 2),
          subtasks: [{ ...task(id(3), 3), subtasks: [{ ...task(id(4), 4), subtasks: [] }] }],
        },
      ],
    };

    expect(taskTreeNodeSchema.safeParse(tooDeep).success).toBe(false);
  });
});
