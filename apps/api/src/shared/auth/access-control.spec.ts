import { describe, expect, it } from 'vitest';
import { hasCapability } from './access-control.js';

describe('hasCapability', () => {
  it('owner, director y manager pueden crear tareas', () => {
    expect(hasCapability('owner', { task: ['create'] })).toBe(true);
    expect(hasCapability('director', { task: ['create'] })).toBe(true);
    expect(hasCapability('manager', { task: ['create'] })).toBe(true);
  });

  it('operator no puede crear tareas (CLAUDE.md §7: "sus tareas y su sitio", no crear tareas nuevas)', () => {
    expect(hasCapability('operator', { task: ['create'] })).toBe(false);
  });

  it('un miembro con varios roles separados por coma autoriza si alguno de los dos alcanza', () => {
    expect(hasCapability('operator,manager', { task: ['create'] })).toBe(true);
    expect(hasCapability('operator, manager', { task: ['create'] })).toBe(true);
  });

  it('un rol que no existe no autoriza nada, no explota', () => {
    expect(hasCapability('rol_inventado', { task: ['create'] })).toBe(false);
  });
});
