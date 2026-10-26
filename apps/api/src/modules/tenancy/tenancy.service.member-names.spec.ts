import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findMemberNames } from './infrastructure/site-access.repository.js';
import { TenancyService } from './tenancy.service.js';

vi.mock('./infrastructure/site-access.repository.js', () => ({
  findMemberNames: vi.fn(),
  findSiteManagerMemberIds: vi.fn(),
  findOrganizationMemberIds: vi.fn(),
  findActiveSiteIds: vi.fn(),
  findMemberForTenant: vi.fn(),
  findSiteForTenant: vi.fn(),
  hasMemberSiteAccessRow: vi.fn(),
}));

const tx = {} as never;
const organizationId = 'org_abc123';

describe('TenancyService.listMemberNames', () => {
  const service = new TenancyService();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findMemberNames).mockResolvedValue([
      { id: 'a', name: 'Ana' },
      { id: 'b', name: 'Beto' },
      { id: 'c', name: 'Carla' },
    ]);
  });

  it('devuelve los nombres en el orden en que se pidieron, no en el de la base', async () => {
    const result = await service.listMemberNames(tx, {
      organizationId,
      memberIds: ['c', 'a', 'b'],
    });

    expect(result.map((m) => m.id)).toEqual(['c', 'a', 'b']);
    expect(result[0]).toEqual({ id: 'c', name: 'Carla' });
  });

  it('quita los repetidos antes de consultar y no los repite en la respuesta', async () => {
    const result = await service.listMemberNames(tx, {
      organizationId,
      memberIds: ['a', 'b', 'a', 'a'],
    });

    expect(findMemberNames).toHaveBeenCalledWith(tx, { organizationId, memberIds: ['a', 'b'] });
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('un id que la base no devuelve (ajeno, inventado o de alguien que ya no está) simplemente falta', async () => {
    const result = await service.listMemberNames(tx, {
      organizationId,
      memberIds: ['a', 'de_otra_org', 'c'],
    });

    expect(result.map((m) => m.id)).toEqual(['a', 'c']);
  });

  it('consulta SIEMPRE con la organización de quien pregunta', async () => {
    await service.listMemberNames(tx, { organizationId, memberIds: ['a'] });

    expect(findMemberNames).toHaveBeenCalledWith(tx, expect.objectContaining({ organizationId }));
  });
});
