import { describe, expect, it } from 'vitest';
import { hasImplicitAllSitesAccess, ORG_ROLES, parseSingleOrgRole } from './org-role.js';

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

  it('lanza si el único rol no es ninguno de los cuatro conocidos', () => {
    expect(() => parseSingleOrgRole('admin')).toThrow();
    expect(() => parseSingleOrgRole('')).toThrow();
  });

  it('el mensaje de un rol corrupto no dice "tu rol no tiene permiso": es un dato inválido, no una autorización que falta', () => {
    expect(() => parseSingleOrgRole('admin')).toThrow(/rol conocido/);
  });
});

describe('hasImplicitAllSitesAccess', () => {
  it('owner y director trabajan en todos los sitios sin filas en member_site_access', () => {
    expect(hasImplicitAllSitesAccess('owner')).toBe(true);
    expect(hasImplicitAllSitesAccess('director')).toBe(true);
  });

  it('manager y operator solo en los sitios donde tienen una fila', () => {
    expect(hasImplicitAllSitesAccess('manager')).toBe(false);
    expect(hasImplicitAllSitesAccess('operator')).toBe(false);
  });

  it('está definida para los cuatro roles conocidos, ninguno queda sin decidir', () => {
    expect(ORG_ROLES.map((role) => hasImplicitAllSitesAccess(role))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });
});
