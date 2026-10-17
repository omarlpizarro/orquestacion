import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CollaborationService } from '../collaboration/collaboration.module.js';
import type { TenancyService } from '../tenancy/tenancy.module.js';
import {
  findProjectById,
  listActiveProjectMemberIds,
  type ProjectRow,
} from './infrastructure/project.repository.js';
import { findTaskById, type TaskRow } from './infrastructure/task.repository.js';
import { ProjectAudienceService } from './project-audience.service.js';

vi.mock('./infrastructure/project.repository.js', () => ({
  findProjectById: vi.fn(),
  listActiveProjectMemberIds: vi.fn(),
}));
vi.mock('./infrastructure/task.repository.js', () => ({ findTaskById: vi.fn() }));

const tx = {} as never;
const organizationId = 'org_abc123';
const taskUpdateId = '01945f4e-0000-7000-8000-0000000000aa';
const taskId = '01945f4e-0000-7000-8000-000000000001';
const projectId = '01945f4e-0000-7000-8000-000000000002';
const siteId = '01945f4e-0000-7000-8000-0000000000bb';

const update = {
  id: taskUpdateId,
  taskId,
  kind: 'block_report' as const,
  body: 'Falta el permiso',
  metadata: {},
  createdByMemberId: 'reporter',
  createdAt: '2026-10-17T12:00:00.000Z',
};
const task = {
  id: taskId,
  projectId,
  title: 'Excavar',
  assigneeMemberId: 'responsable',
} as TaskRow;
const project = (visibility: string) => ({ id: projectId, siteId, visibility }) as ProjectRow;

function build() {
  const collaboration = { findTaskUpdate: vi.fn().mockResolvedValue(update) };
  const tenancy = {
    listSiteManagerMemberIds: vi.fn().mockResolvedValue(['gerente']),
    // Devuelve lo que le llega: el filtro de miembros activos se prueba contra la base.
    filterOrganizationMemberIds: vi.fn(
      async (_tx: unknown, p: { memberIds: string[] }) => p.memberIds,
    ),
  };
  return {
    service: new ProjectAudienceService(
      collaboration as unknown as CollaborationService,
      tenancy as unknown as TenancyService,
    ),
    collaboration,
    tenancy,
  };
}

describe('ProjectAudienceService.listTaskBlockAudience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findTaskById).mockResolvedValue(task);
    vi.mocked(findProjectById).mockResolvedValue(project('reserved'));
    vi.mocked(listActiveProjectMemberIds).mockResolvedValue(['miembro', 'reporter']);
  });

  it('arma la audiencia desde la novedad: miembros, responsable, sin quien reportó', async () => {
    const { service } = build();

    const audience = await service.listTaskBlockAudience(tx, { organizationId, taskUpdateId });

    expect(audience).toEqual({
      taskUpdateId,
      taskId,
      projectId,
      taskTitle: 'Excavar',
      reporterMemberId: 'reporter',
      reason: 'Falta el permiso',
      recipientMemberIds: ['miembro', 'responsable'],
    });
  });

  it('en un proyecto reservado no consulta a los managers del sitio', async () => {
    const { service, tenancy } = build();

    await service.listTaskBlockAudience(tx, { organizationId, taskUpdateId });

    expect(tenancy.listSiteManagerMemberIds).not.toHaveBeenCalled();
  });

  it('en un proyecto de sitio suma a los managers de ESE sitio', async () => {
    vi.mocked(findProjectById).mockResolvedValue(project('site'));
    const { service, tenancy } = build();

    const audience = await service.listTaskBlockAudience(tx, { organizationId, taskUpdateId });

    expect(tenancy.listSiteManagerMemberIds).toHaveBeenCalledWith(tx, { organizationId, siteId });
    expect(audience?.recipientMemberIds).toEqual(['gerente', 'miembro', 'responsable']);
  });

  it('filtra por los miembros que siguen en la organización', async () => {
    const { service, tenancy } = build();
    tenancy.filterOrganizationMemberIds.mockResolvedValue(['miembro']);

    const audience = await service.listTaskBlockAudience(tx, { organizationId, taskUpdateId });

    expect(tenancy.filterOrganizationMemberIds).toHaveBeenCalledWith(tx, {
      organizationId,
      memberIds: ['miembro', 'responsable'],
    });
    expect(audience?.recipientMemberIds).toEqual(['miembro']);
  });

  it('una novedad que no existe no tiene audiencia', async () => {
    const { service, collaboration } = build();
    collaboration.findTaskUpdate.mockResolvedValue(null);

    expect(await service.listTaskBlockAudience(tx, { organizationId, taskUpdateId })).toBeNull();
  });

  it('una novedad que no es un reporte de bloqueo no tiene audiencia (una fila falsa no avisa)', async () => {
    const { service, collaboration } = build();
    collaboration.findTaskUpdate.mockResolvedValue({ ...update, kind: 'comment' });

    expect(await service.listTaskBlockAudience(tx, { organizationId, taskUpdateId })).toBeNull();
    expect(findTaskById).not.toHaveBeenCalled();
  });

  it('una tarea o un proyecto borrados (o que tx no ve) no tienen audiencia', async () => {
    const { service } = build();

    vi.mocked(findTaskById).mockResolvedValueOnce(null);
    expect(await service.listTaskBlockAudience(tx, { organizationId, taskUpdateId })).toBeNull();

    vi.mocked(findProjectById).mockResolvedValueOnce(null);
    expect(await service.listTaskBlockAudience(tx, { organizationId, taskUpdateId })).toBeNull();
  });
});
