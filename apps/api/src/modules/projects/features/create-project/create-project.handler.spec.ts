import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findPriorMutation, recordMutation } from '../../../../shared/database/mutation-log.js';
import type { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import { runWithRequestContext } from '../../../../shared/request-context/request-context.js';
import type { TenancyService } from '../../../tenancy/tenancy.module.js';
import { ProjectCodeTakenError } from '../../domain/errors/project-code-taken.error.js';
import { ProjectCreateForbiddenError } from '../../domain/errors/project-create-forbidden.error.js';
import { ProjectSiteAccessForbiddenError } from '../../domain/errors/project-site-access-forbidden.error.js';
import { ProjectSiteNotFoundError } from '../../domain/errors/project-site-not-found.error.js';
import { ProjectSiteRequiredError } from '../../domain/errors/project-site-required.error.js';
import {
  findProjectById,
  insertProject,
  insertProjectMember,
  type ProjectRow,
} from '../../infrastructure/project.repository.js';
import type { CreateProjectCommand } from './create-project.command.js';
import { CreateProjectHandler } from './create-project.handler.js';

vi.mock('../../../../shared/database/mutation-log.js', () => ({
  findPriorMutation: vi.fn(),
  recordMutation: vi.fn(),
}));
vi.mock('../../infrastructure/project.repository.js', () => ({
  findProjectById: vi.fn(),
  insertProject: vi.fn(),
  insertProjectMember: vi.fn(),
}));

const command: CreateProjectCommand = {
  client_mutation_id: '01945f4e-0000-7000-8000-000000000000',
  id: '01945f4e-0000-7000-8000-000000000001',
  code: 'PRY-1',
  name: 'Frente Norte',
};
const siteId = '01945f4e-0000-7000-8000-0000000000aa';

const createdProject: ProjectRow = {
  id: command.id,
  siteId,
  visibility: 'reserved',
  code: command.code,
  name: command.name,
  description: null,
  status: 'planning',
  createdByMemberId: 'member_abc123',
  version: 1,
  createdAt: '2026-10-11T12:00:00.000Z',
  fullAccess: true,
};

function tenantWith(role: string) {
  return { organizationId: 'org_abc123', memberId: 'member_abc123', role };
}

function buildHandler(
  options: {
    siteExists?: boolean;
    canAccessSite?: boolean;
    sole?: { kind: 'single'; siteId: string } | { kind: 'multiple' } | { kind: 'none' };
  } = {},
) {
  const withTenant = vi.fn(async (fn: (tx: unknown) => unknown) => fn({}));
  const tenancy = {
    siteExists: vi.fn().mockResolvedValue(options.siteExists ?? true),
    canAccessSite: vi.fn().mockResolvedValue(options.canAccessSite ?? true),
    resolveSoleSite: vi.fn().mockResolvedValue(options.sole ?? { kind: 'single', siteId }),
  };
  const handler = new CreateProjectHandler(
    { withTenant } as unknown as TransactionService,
    tenancy as unknown as TenancyService,
  );
  return { handler, withTenant, tenancy };
}

function run<T>(role: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ requestId: 'req-1', tenant: tenantWith(role) }, fn);
}

describe('CreateProjectHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(findPriorMutation).mockResolvedValue(null);
    vi.mocked(findProjectById).mockResolvedValue(createdProject);
  });

  describe('capacidad project:create (RF-C1: solo owner y director)', () => {
    it.each(['manager', 'operator'])(
      'un %s recibe el error de dominio antes de tocar la base',
      async (role) => {
        const { handler, withTenant } = buildHandler();

        await expect(run(role, () => handler.execute(command))).rejects.toBeInstanceOf(
          ProjectCreateForbiddenError,
        );

        // La base no frena el INSERT de `project`: si el handler no corta antes,
        // el manager crea el proyecto.
        expect(withTenant).not.toHaveBeenCalled();
        expect(insertProject).not.toHaveBeenCalled();
        expect(insertProjectMember).not.toHaveBeenCalled();
      },
    );

    it.each(['owner', 'director'])('un %s lo crea', async (role) => {
      const { handler } = buildHandler();
      const output = await run(role, () => handler.execute(command));
      expect(output).toMatchObject({
        id: command.id,
        access_level: 'full',
        visibility: 'reserved',
      });
    });
  });

  it('inserta el proyecto, enseguida al creador como miembro y recién después el registro de la mutación', async () => {
    const { handler } = buildHandler();

    await run('owner', () => handler.execute(command));

    const order = (fn: unknown) => vi.mocked(fn as () => void).mock.invocationCallOrder[0] ?? 0;
    expect(order(insertProject)).toBeLessThan(order(insertProjectMember));
    expect(order(insertProjectMember)).toBeLessThan(order(recordMutation));
    expect(insertProjectMember).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        projectId: command.id,
        memberId: 'member_abc123',
        createdByMemberId: 'member_abc123',
      }),
    );
  });

  it('nunca manda created_at ni version al insertar (ADR-017, adenda)', async () => {
    const { handler } = buildHandler();
    await run('owner', () => handler.execute(command));

    const params = vi.mocked(insertProject).mock.calls[0]?.[1] ?? {};
    expect(params).not.toHaveProperty('createdAt');
    expect(params).not.toHaveProperty('version');
  });

  it('visibilidad reservada por defecto, o la pedida', async () => {
    const { handler } = buildHandler();
    await run('owner', () => handler.execute(command));
    await run('owner', () => handler.execute({ ...command, visibility: 'site' }));

    const visibilities = vi.mocked(insertProject).mock.calls.map(([, params]) => params.visibility);
    expect(visibilities).toEqual(['reserved', 'site']);
  });

  describe('sitio', () => {
    it('sin site_id toma el único sitio de la organización', async () => {
      const { handler, tenancy } = buildHandler();
      await run('owner', () => handler.execute(command));

      expect(tenancy.resolveSoleSite).toHaveBeenCalled();
      expect(vi.mocked(insertProject).mock.calls[0]?.[1].siteId).toBe(siteId);
    });

    it.each([{ kind: 'multiple' }, { kind: 'none' }] as const)(
      'sin site_id y con sitios %o exige elegir uno',
      async (sole) => {
        const { handler } = buildHandler({ sole });
        await expect(run('owner', () => handler.execute(command))).rejects.toBeInstanceOf(
          ProjectSiteRequiredError,
        );
        expect(insertProject).not.toHaveBeenCalled();
      },
    );

    it('un site_id que no existe se rechaza', async () => {
      const { handler } = buildHandler({ siteExists: false });
      await expect(
        run('owner', () => handler.execute({ ...command, site_id: siteId })),
      ).rejects.toBeInstanceOf(ProjectSiteNotFoundError);
    });

    it('un site_id sin acceso pasa por canAccessSite y se rechaza', async () => {
      const { handler, tenancy } = buildHandler({ canAccessSite: false });
      await expect(
        run('owner', () => handler.execute({ ...command, site_id: siteId })),
      ).rejects.toBeInstanceOf(ProjectSiteAccessForbiddenError);
      expect(tenancy.canAccessSite).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ siteId, role: 'owner' }),
      );
    });
  });

  describe('idempotencia', () => {
    it('un reintento de una mutación aplicada devuelve el proyecto sin insertar nada', async () => {
      vi.mocked(findPriorMutation).mockResolvedValue({
        entityId: command.id,
        result: 'applied',
        rejectionReason: null,
      });
      const { handler } = buildHandler();

      const output = await run('owner', () => handler.execute(command));

      expect(output.id).toBe(command.id);
      expect(insertProject).not.toHaveBeenCalled();
      expect(insertProjectMember).not.toHaveBeenCalled();
      expect(recordMutation).not.toHaveBeenCalled();
    });

    it('emite project.created solo cuando crea, no en el reintento', async () => {
      const listener = vi.fn();
      domainEvents.onEvent('project.created', listener);
      const { handler } = buildHandler();

      await run('owner', () => handler.execute(command));
      vi.mocked(findPriorMutation).mockResolvedValue({
        entityId: command.id,
        result: 'applied',
        rejectionReason: null,
      });
      await run('owner', () => handler.execute(command));

      expect(listener).toHaveBeenCalledTimes(1);
      domainEvents.removeListener('project.created', listener);
    });
  });

  describe('violaciones de unicidad', () => {
    const uniqueViolation = (constraint: string) =>
      Object.assign(new Error('Failed query'), { cause: { code: '23505', constraint } });

    it('un código repetido se informa como ProjectCodeTakenError tras reintentar una vez', async () => {
      vi.mocked(insertProject).mockRejectedValue(
        uniqueViolation('project_organization_id_code_unique'),
      );
      const { handler, withTenant } = buildHandler();

      await expect(run('owner', () => handler.execute(command))).rejects.toBeInstanceOf(
        ProjectCodeTakenError,
      );
      expect(withTenant).toHaveBeenCalledTimes(2);
    });

    it('si el primer intento choca pero el reintento encuentra la mutación aplicada, devuelve el proyecto (carrera)', async () => {
      vi.mocked(insertProject).mockRejectedValueOnce(uniqueViolation('project_pkey'));
      vi.mocked(findPriorMutation).mockResolvedValueOnce(null).mockResolvedValueOnce({
        entityId: command.id,
        result: 'applied',
        rejectionReason: null,
      });
      const { handler } = buildHandler();

      const output = await run('owner', () => handler.execute(command));
      expect(output.id).toBe(command.id);
    });
  });
});
