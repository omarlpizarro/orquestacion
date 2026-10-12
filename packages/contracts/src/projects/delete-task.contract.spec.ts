import { describe, expect, it } from 'vitest';
import { deleteTaskInputSchema, deleteTaskOutputSchema } from './delete-task.contract.js';

const valid = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  expected_version: 3,
};

describe('deleteTaskInputSchema', () => {
  it('acepta el pedido mínimo', () => {
    expect(deleteTaskInputSchema.safeParse(valid).success).toBe(true);
  });

  it('exige client_mutation_id, id (UUIDv7) y una expected_version positiva', () => {
    const { client_mutation_id, ...withoutMutation } = valid;
    const { expected_version, ...withoutVersion } = valid;

    expect(deleteTaskInputSchema.safeParse(withoutMutation).success).toBe(false);
    expect(deleteTaskInputSchema.safeParse(withoutVersion).success).toBe(false);
    expect(deleteTaskInputSchema.safeParse({ ...valid, expected_version: 0 }).success).toBe(false);
    expect(deleteTaskInputSchema.safeParse({ ...valid, id: 'no-es-un-uuid' }).success).toBe(false);
  });

  it('rechaza y nombra cualquier otro campo (CLAUDE.md §9)', () => {
    const result = deleteTaskInputSchema.safeParse({ ...valid, cascade: false, status: 'done' });

    expect(result.success).toBe(false);
    const unrecognized = result.error?.issues.find((issue) => issue.code === 'unrecognized_keys');
    expect([...((unrecognized as { keys: string[] } | undefined)?.keys ?? [])].sort()).toEqual([
      'cascade',
      'status',
    ]);
  });
});

describe('deleteTaskOutputSchema', () => {
  it('acepta la respuesta: al menos una tarea borrada', () => {
    const output = {
      id: valid.id,
      deleted_at: '2026-10-14T12:00:00.000Z',
      deleted_task_count: 3,
    };

    expect(deleteTaskOutputSchema.safeParse(output).success).toBe(true);
    expect(deleteTaskOutputSchema.safeParse({ ...output, deleted_task_count: 0 }).success).toBe(
      false,
    );
  });
});
