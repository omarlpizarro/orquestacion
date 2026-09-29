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

  // ADR-016: al crear una organización, Better Auth ejecuta afterAddMember
  // ANTES que afterCreateOrganization, así que cuando corre para el dueño el
  // sitio todavía no existe. La fila del dueño se otorga acá, y solo tiene
  // sentido si el sitio ya está.
  it('le otorga acceso al dueño recién creado, después de asegurar el sitio', async () => {
    vi.mocked(ensureDefaultSite).mockClear();
    vi.mocked(grantAccessToSingleSite).mockClear();

    await handleOrganizationCreated({} as Db, {
      organization: { id: 'org_5' },
      member: { id: 'member_5' },
    });

    expect(grantAccessToSingleSite).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org_5',
      memberId: 'member_5',
    });
    const siteOrder = vi.mocked(ensureDefaultSite).mock.invocationCallOrder[0] ?? 0;
    const grantOrder = vi.mocked(grantAccessToSingleSite).mock.invocationCallOrder[0] ?? 0;
    expect(siteOrder).toBeGreaterThan(0);
    expect(grantOrder).toBeGreaterThan(siteOrder);
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
  it('abre una transacción de tenant con el miembro nuevo y llama a grantAccessToSingleSite', async () => {
    await handleMemberJoined({} as Db, {
      organizationId: 'org_3',
      member: { id: 'member_3' },
    });

    expect(withTenantTransaction).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ organizationId: 'org_3', memberId: 'member_3' }),
      expect.any(Function),
    );
    expect(grantAccessToSingleSite).toHaveBeenCalledWith(expect.anything(), {
      organizationId: 'org_3',
      memberId: 'member_3',
    });
  });

  it('propaga el error si falla el otorgamiento, no lo traga', async () => {
    vi.mocked(grantAccessToSingleSite).mockRejectedValueOnce(new Error('boom'));

    await expect(
      handleMemberJoined({} as Db, {
        organizationId: 'org_4',
        member: { id: 'member_4' },
      }),
    ).rejects.toThrow('boom');
  });
});
