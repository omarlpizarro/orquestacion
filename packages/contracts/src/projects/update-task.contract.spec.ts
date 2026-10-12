import { describe, expect, it } from 'vitest';
import { updateTaskInputSchema } from './update-task.contract.js';

const base = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  expected_version: 3,
};

describe('updateTaskInputSchema', () => {
  it('acepta un solo campo: la edición es parcial', () => {
    expect(updateTaskInputSchema.safeParse({ ...base, title: 'Nuevo' }).success).toBe(true);
    expect(updateTaskInputSchema.safeParse({ ...base, criticality: 'high' }).success).toBe(true);
  });

  it('rechaza un pedido sin ningún campo para editar', () => {
    expect(updateTaskInputSchema.safeParse(base).success).toBe(false);
  });

  it('expected_version es obligatoria y positiva', () => {
    const { expected_version, ...without } = { ...base, title: 'X' };

    expect(updateTaskInputSchema.safeParse(without).success).toBe(false);
    expect(
      updateTaskInputSchema.safeParse({ ...base, title: 'X', expected_version: 0 }).success,
    ).toBe(false);
  });

  it('null borra la descripción y las fechas; el título y la criticidad no se borran', () => {
    expect(
      updateTaskInputSchema.safeParse({
        ...base,
        description: null,
        planned_start_at: null,
        planned_end_at: null,
      }).success,
    ).toBe(true);
    expect(updateTaskInputSchema.safeParse({ ...base, title: null }).success).toBe(false);
    expect(updateTaskInputSchema.safeParse({ ...base, criticality: null }).success).toBe(false);
  });

  it('el título se recorta y no puede quedar vacío', () => {
    expect(updateTaskInputSchema.parse({ ...base, title: '  Nuevo  ' }).title).toBe('Nuevo');
    expect(updateTaskInputSchema.safeParse({ ...base, title: '   ' }).success).toBe(false);
  });

  it('las fechas son hora de pared sin zona horaria', () => {
    expect(
      updateTaskInputSchema.safeParse({ ...base, planned_start_at: '2026-10-22T08:00' }).success,
    ).toBe(true);
    expect(
      updateTaskInputSchema.safeParse({ ...base, planned_start_at: '2026-10-22T08:00:00Z' })
        .success,
    ).toBe(false);
  });

  describe('campos que no se editan acá (CLAUDE.md §9: no se descartan en silencio)', () => {
    it.each([
      ['status', 'done'],
      ['assignee_member_id', 'alguien'],
      ['parent_task_id', '01945f4e-0000-7000-8000-000000000009'],
      ['is_milestone', true],
      ['project_id', '01945f4e-0000-7000-8000-000000000009'],
      ['campo_inventado', 1],
    ])('rechaza %s y lo nombra', (field, value) => {
      const result = updateTaskInputSchema.safeParse({ ...base, title: 'Nuevo', [field]: value });

      expect(result.success).toBe(false);
      const unrecognized = result.error?.issues.find((issue) => issue.code === 'unrecognized_keys');
      expect(unrecognized).toMatchObject({ keys: [field] });
      expect(unrecognized?.message).toContain(field);
    });

    it('nombra todos los campos ajenos si vienen varios', () => {
      const result = updateTaskInputSchema.safeParse({
        ...base,
        title: 'Nuevo',
        status: 'done',
        assignee_member_id: 'alguien',
      });

      const unrecognized = result.error?.issues.find((issue) => issue.code === 'unrecognized_keys');
      expect([...(unrecognized as { keys: string[] }).keys].sort()).toEqual([
        'assignee_member_id',
        'status',
      ]);
    });

    it('un pedido que solo trae un campo ajeno se rechaza por el campo ajeno', () => {
      const result = updateTaskInputSchema.safeParse({ ...base, status: 'done' });

      expect(result.success).toBe(false);
      expect(result.error?.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);
    });
  });
});
