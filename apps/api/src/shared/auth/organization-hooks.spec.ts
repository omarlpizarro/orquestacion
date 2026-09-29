import type { Db, Tx } from '@orq/db';
import { withTenantTransaction } from '@orq/db';
import { describe, expect, it, vi } from 'vitest';
import { ensureDefaultSite } from './ensure-default-site.js';
import { grantAccessToSingleSite } from './member-site-access.js';
import { handleMemberJoined, handleOrganizationCreated } from './organization-hooks.js';

vi.mock('@orq/db', () => ({
  withTenantTransaction: vi.fn((_db: unknown, _ctx: unknown, handler: (tx: Tx) => unknown) =>
    handler({} as Tx),
  ),
}));
vi.mock('./ensure-default-site.js', () => ({ ensureDefaultSite: vi.fn() }));
vi.mock('./member-site-access.js', () => ({ grantAccessToSingleSite: vi.fn() }));

describe('handleOrganizationCreated', () => {
  it('abre una transacción de tenant con el id de la organización y del member recién creados', async () => {
    await handleOrganizationCreated({} as Db, {
      organization: { id: 'org_1' },
      member: { id: 'member_1' },
    });

    expect(withTenantTransaction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ organizationId: 'org_1', memberId: 'member_1' }),
      expect.any(Function),
    );
    expect(ensureDefaultSite).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org_1',
    });
  });

  // ADR-013: verificado contra el paquete instalado de better-auth que la
  // organización y el member ya están confirmados en la base cuando este
  // hook corre, así que no hay nada que este hook pueda revertir si falla.
  // Lo único que puede hacer es no tragarse el error — dejar que se
  // propague es lo que hace que /organization/create le devuelva un error
  // a quien llamó, en vez de una respuesta 200 mintiendo que todo salió
  // bien. Este test prueba esa propagación, no puede forzar una falla real
  // del INSERT (necesitaría Postgres real) — para eso está
  // ensure-default-sites.integration.spec.ts, que prueba la reparación.
  it('propaga el error si falla la creación del sitio, no lo traga', async () => {
    vi.mocked(ensureDefaultSite).mockRejectedValueOnce(new Error('boom'));

    await expect(
      handleOrganizationCreated({} as Db, {
        organization: { id: 'org_2' },
        member: { id: 'member_2' },
      }),
    ).rejects.toThrow('boom');
  });
});

describe('handleMemberJoined', () => {
  it('abre una transacción de tenant con el miembro nuevo y le pasa su rol a grantAccessToSingleSite', async () => {
    await handleMemberJoined({} as Db, {
      organizationId: 'org_3',
      member: { id: 'member_3', role: 'operator' },
    });

    expect(withTenantTransaction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ organizationId: 'org_3', memberId: 'member_3' }),
      expect.any(Function),
    );
    expect(grantAccessToSingleSite).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org_3',
      memberId: 'member_3',
      role: 'operator',
    });
  });

  it('propaga el error si falla el otorgamiento, no lo traga', async () => {
    vi.mocked(grantAccessToSingleSite).mockRejectedValueOnce(new Error('boom'));

    await expect(
      handleMemberJoined({} as Db, {
        organizationId: 'org_4',
        member: { id: 'member_4', role: 'manager' },
      }),
    ).rejects.toThrow('boom');
  });
});
