import { describe, expect, it } from 'vitest';
import {
  getMemberNamesInputSchema,
  getMemberNamesOutputSchema,
  MAX_MEMBER_NAMES_PER_REQUEST,
} from './get-member-names.contract.js';

describe('getMemberNamesInputSchema', () => {
  it('acepta un arreglo de ids', () => {
    expect(getMemberNamesInputSchema.parse({ ids: ['a', 'b'] }).ids).toEqual(['a', 'b']);
  });

  it('un único id suelto (query string `ids=x`) se normaliza a un arreglo', () => {
    expect(getMemberNamesInputSchema.parse({ ids: 'solo' }).ids).toEqual(['solo']);
  });

  it('acepta justo el tope y rechaza uno más', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
    expect(
      getMemberNamesInputSchema.safeParse({ ids: ids(MAX_MEMBER_NAMES_PER_REQUEST) }).success,
    ).toBe(true);
    expect(
      getMemberNamesInputSchema.safeParse({ ids: ids(MAX_MEMBER_NAMES_PER_REQUEST + 1) }).success,
    ).toBe(false);
  });

  it('rechaza no mandar ids, mandar un arreglo vacío o un id vacío', () => {
    expect(getMemberNamesInputSchema.safeParse({}).success).toBe(false);
    expect(getMemberNamesInputSchema.safeParse({ ids: [] }).success).toBe(false);
    expect(getMemberNamesInputSchema.safeParse({ ids: [''] }).success).toBe(false);
    expect(getMemberNamesInputSchema.safeParse({ ids: '' }).success).toBe(false);
  });

  it('acepta los ids de Better Auth (strings opacos que no son UUID)', () => {
    expect(
      getMemberNamesInputSchema.safeParse({ ids: ['3k9fQ2xLmN8pR5tVwYz1AbCdEfGhJkLm'] }).success,
    ).toBe(true);
  });
});

describe('getMemberNamesOutputSchema', () => {
  it('lleva solo id y nombre', () => {
    const output = { members: [{ id: 'a', name: 'Ana' }] };
    expect(getMemberNamesOutputSchema.parse(output)).toEqual(output);
  });

  it('una lista vacía es válida (ningún id era de la organización)', () => {
    expect(getMemberNamesOutputSchema.safeParse({ members: [] }).success).toBe(true);
  });

  it('descarta campos de más: no hay manera de que se cuele un email', () => {
    const parsed = getMemberNamesOutputSchema.parse({
      members: [{ id: 'a', name: 'Ana', email: 'ana@example.com' }],
    });
    expect(parsed.members[0]).toEqual({ id: 'a', name: 'Ana' });
  });
});
