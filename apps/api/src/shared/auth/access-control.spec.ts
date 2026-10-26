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

describe('hasCapability: site:grant_access', () => {
  it('solo owner y director pueden otorgar acceso a un sitio', () => {
    expect(hasCapability('owner', { site: ['grant_access'] })).toBe(true);
    expect(hasCapability('director', { site: ['grant_access'] })).toBe(true);
    expect(hasCapability('manager', { site: ['grant_access'] })).toBe(false);
    expect(hasCapability('operator', { site: ['grant_access'] })).toBe(false);
  });
});

describe('hasCapability: project', () => {
  it('solo owner y director crean proyectos (RF-C1); manager y operator no', () => {
    expect(hasCapability('owner', { project: ['create'] })).toBe(true);
    expect(hasCapability('director', { project: ['create'] })).toBe(true);
    expect(hasCapability('manager', { project: ['create'] })).toBe(false);
    expect(hasCapability('operator', { project: ['create'] })).toBe(false);
  });

  it('cambiar la visibilidad y manejar miembros por rol es solo de owner y director', () => {
    for (const capability of ['change_visibility', 'manage_members'] as const) {
      expect(hasCapability('owner', { project: [capability] })).toBe(true);
      expect(hasCapability('director', { project: [capability] })).toBe(true);
      expect(hasCapability('manager', { project: [capability] })).toBe(false);
      expect(hasCapability('operator', { project: [capability] })).toBe(false);
    }
  });
});

describe('hasCapability: task:update', () => {
  it('owner, director y manager editan tareas; operator no, ni las suyas', () => {
    expect(hasCapability('owner', { task: ['update'] })).toBe(true);
    expect(hasCapability('director', { task: ['update'] })).toBe(true);
    expect(hasCapability('manager', { task: ['update'] })).toBe(true);
    expect(hasCapability('operator', { task: ['update'] })).toBe(false);
  });
});

describe('hasCapability: task:assign', () => {
  it('owner, director y manager asignan; operator no', () => {
    expect(hasCapability('owner', { task: ['assign'] })).toBe(true);
    expect(hasCapability('director', { task: ['assign'] })).toBe(true);
    expect(hasCapability('manager', { task: ['assign'] })).toBe(true);
    expect(hasCapability('operator', { task: ['assign'] })).toBe(false);
  });
});

describe('hasCapability: task:delete', () => {
  it('owner, director y manager borran tareas; operator no', () => {
    expect(hasCapability('owner', { task: ['delete'] })).toBe(true);
    expect(hasCapability('director', { task: ['delete'] })).toBe(true);
    expect(hasCapability('manager', { task: ['delete'] })).toBe(true);
    expect(hasCapability('operator', { task: ['delete'] })).toBe(false);
  });
});

describe('hasCapability: notification:read', () => {
  it('los cuatro roles ven sus propios avisos', () => {
    for (const role of ['owner', 'director', 'manager', 'operator']) {
      expect(hasCapability(role, { notification: ['read'] }), role).toBe(true);
    }
  });

  it('un rol que no existe no los ve', () => {
    expect(hasCapability('rol_inventado', { notification: ['read'] })).toBe(false);
  });
});

describe('hasCapability: directory:read', () => {
  it('los cuatro roles resuelven nombres de los miembros de su organización', () => {
    for (const role of ['owner', 'director', 'manager', 'operator']) {
      expect(hasCapability(role, { directory: ['read'] }), role).toBe(true);
    }
  });

  it('un rol que no existe no los resuelve', () => {
    expect(hasCapability('rol_inventado', { directory: ['read'] })).toBe(false);
  });
});
