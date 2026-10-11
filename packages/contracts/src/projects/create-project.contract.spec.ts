import { describe, expect, it } from 'vitest';
import { createProjectInputSchema, projectOutputSchema } from './create-project.contract.js';
import { listProjectsInputSchema } from './list-projects.contract.js';
import { removeProjectMemberInputSchema } from './remove-project-member.contract.js';

const validInput = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000003',
  code: 'PRY-1',
  name: 'Frente Norte',
};

describe('createProjectInputSchema', () => {
  it('acepta el mínimo: el sitio y la visibilidad son opcionales', () => {
    const result = createProjectInputSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('acepta visibilidad reserved y site, rechaza otra', () => {
    for (const visibility of ['reserved', 'site']) {
      expect(createProjectInputSchema.safeParse({ ...validInput, visibility }).success).toBe(true);
    }
    expect(
      createProjectInputSchema.safeParse({ ...validInput, visibility: 'public' }).success,
    ).toBe(false);
  });

  it('rechaza código o nombre vacíos (también solo espacios)', () => {
    expect(createProjectInputSchema.safeParse({ ...validInput, code: '  ' }).success).toBe(false);
    expect(createProjectInputSchema.safeParse({ ...validInput, name: '' }).success).toBe(false);
  });

  it('rechaza sin client_mutation_id', () => {
    const { client_mutation_id, ...withoutMutationId } = validInput;
    expect(createProjectInputSchema.safeParse(withoutMutationId).success).toBe(false);
  });

  it('no deja pasar created_at ni version: la base los pone (ADR-017, adenda)', () => {
    const parsed = createProjectInputSchema.parse({
      ...validInput,
      created_at: '2020-01-01T00:00:00.000Z',
      version: 5,
    });
    expect(parsed).not.toHaveProperty('created_at');
    expect(parsed).not.toHaveProperty('version');
  });
});

describe('projectOutputSchema', () => {
  it('acepta un proyecto con acceso reducido (sin descripción)', () => {
    const result = projectOutputSchema.safeParse({
      id: '01945f4e-0000-7000-8000-000000000003',
      site_id: '01945f4e-0000-7000-8000-0000000000aa',
      code: 'PRY-1',
      name: 'Frente Norte',
      description: null,
      status: 'planning',
      visibility: 'reserved',
      access_level: 'assigned',
      created_by_member_id: 'member_abc123',
      version: 1,
      created_at: '2026-10-11T12:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });
});

describe('listProjectsInputSchema', () => {
  it('convierte el limit que llega como texto en la query', () => {
    expect(listProjectsInputSchema.parse({ limit: '25' })).toEqual({ limit: 25 });
    expect(listProjectsInputSchema.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('removeProjectMemberInputSchema', () => {
  it('el member_id es un id opaco de Better Auth, no un UUID', () => {
    const result = removeProjectMemberInputSchema.safeParse({
      client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
      project_id: '01945f4e-0000-7000-8000-000000000003',
      member_id: 'vK3pQ9mZ2xLw8sTn',
    });
    expect(result.success).toBe(true);
  });
});
