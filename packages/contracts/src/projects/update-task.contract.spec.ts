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

  it('no deja pasar el estado, el responsable ni el padre: se ignoran', () => {
    const parsed = updateTaskInputSchema.parse({
      ...base,
      title: 'Nuevo',
      status: 'done',
      assignee_member_id: 'alguien',
      parent_task_id: '01945f4e-0000-7000-8000-000000000009',
    });

    expect(parsed).not.toHaveProperty('status');
    expect(parsed).not.toHaveProperty('assignee_member_id');
    expect(parsed).not.toHaveProperty('parent_task_id');
  });

  it('un pedido que solo trae campos ignorados cuenta como vacío', () => {
    expect(updateTaskInputSchema.safeParse({ ...base, status: 'done' }).success).toBe(false);
  });
});
