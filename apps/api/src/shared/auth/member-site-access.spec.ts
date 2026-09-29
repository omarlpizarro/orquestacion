import type { Tx } from '@orq/db';
import { describe, expect, it, vi } from 'vitest';
import { grantAccessToSingleSite, insertMemberSiteAccess } from './member-site-access.js';

function fakeTx(...responses: Array<{ rows: unknown[] }>) {
  const execute = vi.fn();
  for (const response of responses) execute.mockResolvedValueOnce(response);
  return { tx: { execute } as unknown as Tx, execute };
}

const params = { organizationId: 'org_1', memberId: 'member_1' };

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
  it('otorga acceso cuando la organización tiene un solo sitio', async () => {
    const { tx, execute } = fakeTx({ rows: [{ id: 'site_1' }] }, { rows: [{ member_id: 'm' }] });

    expect(await grantAccessToSingleSite(tx, params)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('devuelve false si el miembro ya tenía acceso', async () => {
    const { tx } = fakeTx({ rows: [{ id: 'site_1' }] }, { rows: [] });

    expect(await grantAccessToSingleSite(tx, params)).toBe(false);
  });

  it('no adivina con más de un sitio: no inserta nada', async () => {
    const { tx, execute } = fakeTx({ rows: [{ id: 'site_1' }, { id: 'site_2' }] });

    expect(await grantAccessToSingleSite(tx, params)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('no hace nada si la organización no tiene ningún sitio', async () => {
    const { tx, execute } = fakeTx({ rows: [] });

    expect(await grantAccessToSingleSite(tx, params)).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
