import { describe, expect, it } from 'vitest';
import { createTaskInputSchema, taskOutputSchema } from './create-task.contract.js';

const validInput = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000003',
  project_id: '01945f4e-0000-7000-8000-000000000001',
  title: 'Preparar el frente norte',
};

describe('createTaskInputSchema', () => {
  it('acepta el mínimo requerido', () => {
    expect(createTaskInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('acepta una fecha planificada local sin zona horaria', () => {
    const result = createTaskInputSchema.safeParse({
      ...validInput,
      planned_start_at: '2026-09-29T08:00',
    });
    expect(result.success).toBe(true);
  });

  it('rechaza una fecha planificada con zona horaria adjunta', () => {
    const result = createTaskInputSchema.safeParse({
      ...validInput,
      planned_start_at: '2026-09-29T08:00:00Z',
    });
    expect(result.success).toBe(false);
  });

  it('rechaza sin client_mutation_id', () => {
    const { client_mutation_id, ...withoutId } = validInput;
    expect(createTaskInputSchema.safeParse(withoutId).success).toBe(false);
  });

  it('rechaza un título vacío', () => {
    const result = createTaskInputSchema.safeParse({ ...validInput, title: '' });
    expect(result.success).toBe(false);
  });
});

describe('taskOutputSchema', () => {
  it('acepta una tarea recién creada', () => {
    const result = taskOutputSchema.safeParse({
      id: '01945f4e-0000-7000-8000-000000000002',
      project_id: validInput.project_id,
      parent_task_id: null,
      depth: 1,
      title: validInput.title,
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
      created_at: '2026-09-20T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});
