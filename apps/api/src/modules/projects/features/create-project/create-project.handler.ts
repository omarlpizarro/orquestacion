import { Injectable } from '@nestjs/common';
import { newId, type ProjectOutput } from '@orq/contracts';
import type { Tx } from '@orq/db';
import { hasCapability } from '../../../../shared/auth/access-control.js';
import { parseSingleOrgRole } from '../../../../shared/auth/org-role.js';
import { claimMutation } from '../../../../shared/database/mutation-log.js';
import {
  hasPostgresErrorCode,
  postgresErrorConstraint,
  UNIQUE_VIOLATION,
} from '../../../../shared/database/postgres-errors.js';
import { TransactionService } from '../../../../shared/database/transaction.service.js';
import { domainEvents } from '../../../../shared/domain-events/domain-events.js';
import {
  getRequestContext,
  type TenantIdentity,
} from '../../../../shared/request-context/request-context.js';
import { TenancyService } from '../../../tenancy/tenancy.module.js';
import { ProjectCodeTakenError } from '../../domain/errors/project-code-taken.error.js';
import { ProjectCreateForbiddenError } from '../../domain/errors/project-create-forbidden.error.js';
import { ProjectIdTakenError } from '../../domain/errors/project-id-taken.error.js';
import { ProjectNotFoundError } from '../../domain/errors/project-not-found.error.js';
import { ProjectSiteAccessForbiddenError } from '../../domain/errors/project-site-access-forbidden.error.js';
import { ProjectSiteNotFoundError } from '../../domain/errors/project-site-not-found.error.js';
import { ProjectSiteRequiredError } from '../../domain/errors/project-site-required.error.js';
import {
  findProjectById,
  insertProject,
  insertProjectMember,
  type ProjectRow,
} from '../../infrastructure/project.repository.js';
import { toProjectOutput } from '../../infrastructure/project-output.mapper.js';
import type { CreateProjectCommand } from './create-project.command.js';

const PROJECT_CODE_UNIQUE = 'project_organization_id_code_unique';
const PROJECT_PKEY = 'project_pkey';

interface CreateOutcome {
  project: ProjectRow;
  /** `false` cuando es el reintento de una mutación ya aplicada. */
  created: boolean;
}

@Injectable()
export class CreateProjectHandler {
  constructor(
    private readonly transactions: TransactionService,
    private readonly tenancy: TenancyService,
  ) {}

  async execute(command: CreateProjectCommand): Promise<ProjectOutput> {
    const { requestId, tenant } = getRequestContext();
    if (!tenant) {
      throw new Error('create-project requiere una sesión con organización activa.');
    }

    // La capacidad se evalúa acá, antes de abrir ninguna transacción: la base no
    // frena el INSERT de `project` (no tiene policy restrictiva de INSERT, y el
    // creador se da acceso a sí mismo durante la transacción de creación, ADR-017
    // adenda). Un manager o un operator nunca llegan a tocarla.
    if (!hasCapability(tenant.role, { project: ['create'] })) {
      throw new ProjectCreateForbiddenError();
    }

    const { project, created } = await this.createOrReplay(command, tenant);

    // Después del commit, nunca desde dentro del callback (ADR-009).
    if (created) {
      domainEvents.emitEvent('project.created', {
        projectId: project.id,
        organizationId: tenant.organizationId,
        requestId,
      });
    }

    return toProjectOutput(project);
  }

  /**
   * Dos pedidos con el mismo `client_mutation_id` a la vez se serializan en
   * `claimMutation` (ADR-007): el segundo espera, ve la mutación confirmada y
   * devuelve el proyecto del primero. No hace falta reintentar.
   *
   * Lo que sí puede chocar son otras dos unicidades, y se informan como error de
   * dominio: el código del proyecto (único por organización) y el `id` (un
   * cliente que lo reusa con una mutación nueva). El código se detecta por la
   * restricción de la base y no con un `SELECT` previo, porque RLS le esconde a
   * quien crea los proyectos reservados ajenos: el `SELECT` diría "libre" y el
   * `INSERT` fallaría igual.
   */
  private async createOrReplay(
    command: CreateProjectCommand,
    tenant: TenantIdentity,
  ): Promise<CreateOutcome> {
    try {
      return await this.transactions.withTenant((tx) => this.applyMutation(command, tenant, tx));
    } catch (error) {
      if (!hasPostgresErrorCode(error, UNIQUE_VIOLATION)) throw error;
      const constraint = postgresErrorConstraint(error);
      if (constraint === PROJECT_CODE_UNIQUE) throw new ProjectCodeTakenError(command.code);
      if (constraint === PROJECT_PKEY) throw new ProjectIdTakenError(command.id);
      throw error;
    }
  }

  private async applyMutation(
    command: CreateProjectCommand,
    tenant: TenantIdentity,
    tx: Tx,
  ): Promise<CreateOutcome> {
    const { organizationId, memberId } = tenant;

    // Primera sentencia de la transacción: se reserva la mutación antes de leer
    // nada (ADR-007).
    const claim = await claimMutation(tx, {
      clientMutationId: command.client_mutation_id,
      organizationId,
      memberId,
      kind: 'project.create',
      entityId: command.id,
    });
    if (!claim.claimed) {
      const existing = await findProjectById(tx, {
        organizationId,
        projectId: claim.prior.entityId ?? command.id,
      });
      // Si ya no lo ve (le quitaron el acceso después), no hay respuesta que reconstruir.
      if (!existing) throw new ProjectNotFoundError(command.id);
      return { project: existing, created: false };
    }

    const siteId = await this.resolveSiteId(tx, command, tenant);

    // Orden obligatorio (ADR-017, adenda): INSERT de project, enseguida INSERT
    // del creador como miembro, y recién después cualquier otra cosa. Un UPDATE
    // del proyecto antes del segundo INSERT sube `version` a 2 y corta el acceso
    // transitorio. Sin `RETURNING`, y sin mandar `created_at` ni `version`.
    await insertProject(tx, {
      id: command.id,
      organizationId,
      createdByMemberId: memberId,
      siteId,
      code: command.code,
      name: command.name,
      description: command.description ?? null,
      visibility: command.visibility ?? 'reserved',
    });
    // También si es owner o director: la fila sobrevive a un cambio de rol (ADR-017 §2).
    await insertProjectMember(tx, {
      id: newId(),
      organizationId,
      createdByMemberId: memberId,
      projectId: command.id,
      memberId,
    });

    const project = await findProjectById(tx, { organizationId, projectId: command.id });
    if (!project) {
      throw new Error(`El proyecto ${command.id} no es visible para su creador tras crearlo.`);
    }
    return { project, created: true };
  }

  /**
   * Un `site_id` explícito tiene que existir y pasar por `canAccessSite`, como en
   * `create-task`. Sin `site_id`, se toma el único sitio activo de la organización
   * (reparándolo con `ensureDefaultSite` si no tuviera ninguno, ADR-013); con más
   * de uno no se elige por quien crea el proyecto.
   */
  private async resolveSiteId(
    tx: Tx,
    command: CreateProjectCommand,
    tenant: TenantIdentity,
  ): Promise<string> {
    const { organizationId, memberId } = tenant;

    if (command.site_id) {
      const exists = await this.tenancy.siteExists(tx, {
        organizationId,
        siteId: command.site_id,
      });
      if (!exists) throw new ProjectSiteNotFoundError(command.site_id);

      const canAccess = await this.tenancy.canAccessSite(tx, {
        organizationId,
        memberId,
        role: parseSingleOrgRole(tenant.role),
        siteId: command.site_id,
      });
      if (!canAccess) throw new ProjectSiteAccessForbiddenError(command.site_id);
      return command.site_id;
    }

    const sole = await this.tenancy.resolveSoleSite(tx, { organizationId });
    if (sole.kind !== 'single') throw new ProjectSiteRequiredError();
    return sole.siteId;
  }
}
