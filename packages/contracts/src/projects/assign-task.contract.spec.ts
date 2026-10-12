import { describe, expect, it } from 'vitest';
import { assignTaskInputSchema } from './assign-task.contract.js';

const base = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  expected_version: 3,
};

describe('assignTaskInputSchema', () => {
  it('acepta asignar a un miembro (id opaco de Better Auth, no un UUID)', () => {
    expect(
      assignTaskInputSchema.safeParse({ ...base, assignee_member_id: 'vK3pQ9mZ2xLw8sTn' }).success,
    ).toBe(true);
  });

  it('acepta null: dejar la tarea sin responsable', () => {
    expect(assignTaskInputSchema.safeParse({ ...base, assignee_member_id: null }).success).toBe(
      true,
    );
  });

  it('omitir assignee_member_id es un error, no "no cambiar"', () => {
    expect(assignTaskInputSchema.safeParse(base).success).toBe(false);
  });

  it('rechaza un responsable vacío', () => {
    expect(assignTaskInputSchema.safeParse({ ...base, assignee_member_id: '' }).success).toBe(
      false,
    );
  });

  it('expected_version es obligatoria y positiva', () => {
    const { expected_version, ...without } = { ...base, assignee_member_id: null };

    expect(assignTaskInputSchema.safeParse(without).success).toBe(false);
    expect(
      assignTaskInputSchema.safeParse({ ...base, assignee_member_id: null, expected_version: 0 })
        .success,
    ).toBe(false);
  });

  it('rechaza y nombra cualquier otro campo (CLAUDE.md §9: no se descarta en silencio)', () => {
    const result = assignTaskInputSchema.safeParse({
      ...base,
      assignee_member_id: null,
      status: 'done',
      title: 'Otro',
    });

    expect(result.success).toBe(false);
    const unrecognized = result.error?.issues.find((issue) => issue.code === 'unrecognized_keys');
    expect([...((unrecognized as { keys: string[] } | undefined)?.keys ?? [])].sort()).toEqual([
      'status',
      'title',
    ]);
  });
});
