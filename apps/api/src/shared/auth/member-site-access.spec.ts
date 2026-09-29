import { Logger } from '@nestjs/common';
import type { Tx } from '@orq/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grantAccessToSingleSite, insertMemberSiteAccess } from './member-site-access.js';

function fakeTx(...responses: Array<{ rows: unknown[] }>) {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  return { tx: { execute } as unknown as Tx, execute };
}

const params = { organizationId: 'org_1', memberId: 'member_1' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('insertMemberSiteAccess', () => {
  it('devuelve true cuando insertó la fila', async () => {
    const { tx } = fakeTx({ rows: [{ member_id: 'member_1' }] });

    expect(await insertMemberSiteAccess(tx, { ...params, siteId: 'site_1' })).toBe(true);
  });

  it('devuelve false cuando la fila ya existía (ON CONFLICT DO NOTHING no devuelve nada)', async () => {
    const { tx } = fakeTx({ rows: [] });

    expect(await insertMemberSiteAccess(tx, { ...params, siteId: 'site_1' })).toBe(false);
  });
});

describe('grantAccessToSingleSite', () => {
  it('otorga acceso a un manager o un operator cuando la organización tiene un solo sitio', async () => {
    for (const role of ['manager', 'operator']) {
      const { tx, execute } = fakeTx({ rows: [{ id: 'site_1' }] }, { rows: [{ member_id: 'm' }] });

      expect(await grantAccessToSingleSite(tx, { ...params, role })).toBe(true);
      expect(execute).toHaveBeenCalledTimes(2);
    }
  });

  it('devuelve false si el miembro ya tenía acceso', async () => {
    const { tx } = fakeTx({ rows: [{ id: 'site_1' }] }, { rows: [] });

    expect(await grantAccessToSingleSite(tx, { ...params, role: 'operator' })).toBe(false);
  });

  it('no adivina con más de un sitio: no inserta nada', async () => {
    const { tx, execute } = fakeTx({ rows: [{ id: 'site_1' }, { id: 'site_2' }] });

    expect(await grantAccessToSingleSite(tx, { ...params, role: 'operator' })).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('no hace nada si la organización no tiene ningún sitio', async () => {
    const { tx, execute } = fakeTx({ rows: [] });

    expect(await grantAccessToSingleSite(tx, { ...params, role: 'manager' })).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('owner y director ya trabajan en todos los sitios: no consulta ni inserta nada', async () => {
    for (const role of ['owner', 'director']) {
      const { tx, execute } = fakeTx();

      expect(await grantAccessToSingleSite(tx, { ...params, role })).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    }
  });

  describe('rol que no se puede interpretar', () => {
    it.each([
      ['desconocido', 'admin'],
      ['vacío', ''],
      ['varios roles distintos', 'manager,operator'],
    ])('%s: no otorga nada y deja un error en el log', async (_label, role) => {
      const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
      const { tx, execute } = fakeTx();

      expect(await grantAccessToSingleSite(tx, { ...params, role })).toBe(false);

      expect(execute).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      const [message] = error.mock.calls[0] ?? [];
      expect(message).toContain('member_1');
      expect(message).toContain('org_1');
      expect(message).toContain(`"${role}"`);
    });
  });
});
