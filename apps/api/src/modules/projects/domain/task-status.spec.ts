import { describe, expect, it } from 'vitest';
import { parseSingleOrgRole } from './task-status.js';

describe('parseSingleOrgRole', () => {
  it('devuelve el rol tal cual cuando hay uno solo', () => {
    expect(parseSingleOrgRole('operator')).toBe('operator');
    expect(parseSingleOrgRole('owner')).toBe('owner');
  });

  it('tolera espacios alrededor del rol', () => {
    expect(parseSingleOrgRole('  manager  ')).toBe('manager');
  });

  it('deduplica el mismo rol repetido, no lo cuenta como "varios"', () => {
    expect(parseSingleOrgRole('owner,owner')).toBe('owner');
    expect(parseSingleOrgRole('owner, owner')).toBe('owner');
  });

  it('lanza si llegan dos o más roles distintos: no hay forma segura de elegir uno', () => {
    expect(() => parseSingleOrgRole('owner,operator')).toThrow();
    expect(() => parseSingleOrgRole('manager,director')).toThrow();
  });

  it('el mensaje de error menciona por qué (para quien lo vea en un log)', () => {
    expect(() => parseSingleOrgRole('owner,operator')).toThrow(/hasCapability/);
  });
});
