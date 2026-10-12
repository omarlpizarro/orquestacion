import { describe, expect, it } from 'vitest';
import { addTaskCommentInputSchema } from './add-task-comment.contract.js';

const valid = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  task_id: '01945f4e-0000-7000-8000-000000000001',
  id: '01945f4e-0000-7000-8000-000000000002',
  body: 'Llegó el camión',
};

describe('addTaskCommentInputSchema', () => {
  it('acepta un comentario de texto y lo recorta', () => {
    const parsed = addTaskCommentInputSchema.parse({ ...valid, body: '  Llegó el camión \n' });

    expect(parsed.body).toBe('Llegó el camión');
  });

  it.each(['', ' ', '\t\n  '])('rechaza un cuerpo vacío o de solo espacios (%j)', (body) => {
    expect(addTaskCommentInputSchema.safeParse({ ...valid, body }).success).toBe(false);
  });

  it('rechaza más de 4000 caracteres', () => {
    expect(addTaskCommentInputSchema.safeParse({ ...valid, body: 'a'.repeat(4001) }).success).toBe(
      false,
    );
    expect(addTaskCommentInputSchema.safeParse({ ...valid, body: 'a'.repeat(4000) }).success).toBe(
      true,
    );
  });

  it('conserva los saltos de línea del medio', () => {
    expect(addTaskCommentInputSchema.parse({ ...valid, body: 'uno\ndos' }).body).toBe('uno\ndos');
  });

  it('exige client_mutation_id y el id de la novedad, ambos UUIDv7', () => {
    const { client_mutation_id, ...withoutMutation } = valid;
    const { id, ...withoutId } = valid;

    expect(addTaskCommentInputSchema.safeParse(withoutMutation).success).toBe(false);
    expect(addTaskCommentInputSchema.safeParse(withoutId).success).toBe(false);
    expect(addTaskCommentInputSchema.safeParse({ ...valid, id: 'no-es-un-uuid' }).success).toBe(
      false,
    );
  });

  it('solo texto: ignora cualquier otro campo (no hay adjuntos ni kind)', () => {
    const parsed = addTaskCommentInputSchema.parse({ ...valid, kind: 'block_report', file: 'x' });

    expect(parsed).not.toHaveProperty('kind');
    expect(parsed).not.toHaveProperty('file');
  });
});
