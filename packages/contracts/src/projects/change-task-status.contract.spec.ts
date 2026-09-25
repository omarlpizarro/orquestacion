import { describe, expect, it } from 'vitest';
import { changeTaskStatusInputSchema } from './change-task-status.contract.js';

const validInput = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  to_status: 'in_progress',
  expected_version: 1,
};

describe('changeTaskStatusInputSchema', () => {
  it('acepta el mínimo requerido, sin reason', () => {
    expect(changeTaskStatusInputSchema.safeParse(validInput).success).toBe(true);
  });

  it('acepta un reason cuando viene', () => {
    const result = changeTaskStatusInputSchema.safeParse({
      ...validInput,
      to_status: 'blocked',
      reason: 'Falta el permiso municipal',
    });
    expect(result.success).toBe(true);
  });

  it('rechaza un to_status que no existe en el enum', () => {
    const result = changeTaskStatusInputSchema.safeParse({ ...validInput, to_status: 'archived' });
    expect(result.success).toBe(false);
  });

  it('rechaza expected_version menor a 1', () => {
    const result = changeTaskStatusInputSchema.safeParse({ ...validInput, expected_version: 0 });
    expect(result.success).toBe(false);
  });

  it('rechaza un reason vacío', () => {
    const result = changeTaskStatusInputSchema.safeParse({ ...validInput, reason: '' });
    expect(result.success).toBe(false);
  });

  it('rechaza sin client_mutation_id', () => {
    const { client_mutation_id, ...withoutId } = validInput;
    expect(changeTaskStatusInputSchema.safeParse(withoutId).success).toBe(false);
  });
});
